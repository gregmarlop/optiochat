/**
 * Optio Signal Server (privacy-first, hardened)
 *
 * Goals:
 * - Zero logging/output (no stdout/stderr logs)
 * - Strict input validation + size limits
 * - Rate limiting (per-connection + per-IP)
 * - Origin allowlist (deny-by-default when configured)
 * - Robust room cleanup
 * - Duplicate signal deduplication (bounded TTL+LRU)
 *
 * NOTE: This server is intentionally "quiet". For troubleshooting, reproduce
 * issues locally/staging with debuggers or packet inspection.
 */

'use strict';

const http = require('http');
const crypto = require('crypto');
const WebSocket = require('ws');

// ============== CONFIG ==============
const PORT = Number.parseInt(process.env.PORT || '3000', 10);

// WS frame size limit (ws enforces this before delivering messages)
const MAX_MESSAGE_SIZE = 64 * 1024; // 64KB

// Heartbeat
const HEARTBEAT_INTERVAL_MS = 25_000;

// Room lifecycle
const MAX_ROOM_AGE_MS = 60 * 60 * 1000; // 1h

// Per-connection rate limit
const CONN_RATE_WINDOW_MS = 1_000;
const CONN_RATE_MAX = 50;

// Per-IP rate limit
const IP_RATE_WINDOW_MS = 60_000;
const IP_RATE_MAX = 100;

// Origin allowlist
// - If ALLOWED_ORIGINS is set (comma-separated), only those origins are accepted.
// - If not set, Origin is not required (allows non-browser clients).
// - If set and Origin is missing/empty, the connection is rejected.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

// Trust proxy for IP extraction (ONLY enable if you control the proxy).
const TRUST_PROXY = process.env.TRUST_PROXY === '1';

// ============== STATE ==============
/** @type {Map<string, {host: WebSocket|null, guest: WebSocket|null, createdAt: number, seenIds: BoundedSeenIds}>} */
const rooms = new Map();
/** @type {WeakMap<WebSocket, {id: string, roomCode: string|null, isHost: boolean, msgCount: number, msgWindowStart: number}>} */
const clients = new WeakMap();

// ============== UTILITIES ==============
function randomId() {
  // 64-bit id as base64url (11 chars)
  return crypto.randomBytes(8).toString('base64url');
}

function sha256Base64Url22(str) {
  return crypto.createHash('sha256').update(str).digest('base64url').slice(0, 22);
}

function normalizeRoomCode(room) {
  return String(room).toLowerCase().trim();
}

function isValidRoomCode(room) {
  // conservative: lowercase alnum + dash, 1..50
  return /^[a-z0-9-]{1,50}$/.test(room);
}

function getOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return '';
  return String(origin);
}

function getClientIp(req) {
  // Best-effort. If behind a proxy, only trust XFF when explicitly enabled.
  if (TRUST_PROXY) {
    const xff = req.headers['x-forwarded-for'];
    if (typeof xff === 'string' && xff.length > 0) {
      // Left-most is the original client.
      return xff.split(',')[0].trim();
    }
  }
  // Fallback: remoteAddress
  return req.socket.remoteAddress || '';
}

function sendGenericError(ws) {
  // Generic by design (no details)
  if (ws.readyState === WebSocket.OPEN) {
    try { ws.send(JSON.stringify({ type: 'error' })); } catch (_) {}
  }
}

function safeSend(ws, obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try { ws.send(JSON.stringify(obj)); } catch (_) {}
  }
}

function validateMessageShape(msg) {
  if (!msg || typeof msg !== 'object') return false;
  if (typeof msg.type !== 'string') return false;

  switch (msg.type) {
    case 'create':
    case 'join': {
      if (typeof msg.room !== 'string') return false;
      const room = normalizeRoomCode(msg.room);
      return isValidRoomCode(room);
    }
    case 'signal': {
      // Accept only object payload with either {sdp} or {candidate} typical shapes
      if (!msg.data || typeof msg.data !== 'object') return false;
      const d = msg.data;
      const hasSdp = typeof d.sdp === 'object' && d.sdp && typeof d.sdp.type === 'string' && typeof d.sdp.sdp === 'string';
      const hasCand = typeof d.candidate === 'object' && d.candidate && typeof d.candidate.candidate === 'string';
      // Allow either (or both) to keep compatibility.
      return hasSdp || hasCand;
    }
    case 'leave':
    case 'pong':
      return true;
    default:
      return false;
  }
}

class BoundedSeenIds {
  /**
   * @param {{max: number, ttlMs: number}} opts
   */
  constructor(opts) {
    this.max = opts.max;
    this.ttlMs = opts.ttlMs;
    /** @type {Map<string, number>} */
    this.map = new Map(); // key -> timestamp
  }

  _purgeExpired(now) {
    // Map preserves insertion order; expired entries likely near front.
    for (const [k, ts] of this.map) {
      if (now - ts <= this.ttlMs) break;
      this.map.delete(k);
    }
  }

  has(key, now = Date.now()) {
    this._purgeExpired(now);
    const ts = this.map.get(key);
    if (ts == null) return false;
    if (now - ts > this.ttlMs) {
      this.map.delete(key);
      return false;
    }
    // refresh LRU
    this.map.delete(key);
    this.map.set(key, now);
    return true;
  }

  add(key, now = Date.now()) {
    this._purgeExpired(now);
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, now);
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next().value;
      if (oldest == null) break;
      this.map.delete(oldest);
    }
  }
}

class RateLimiter {
  /**
   * @param {{windowMs: number, max: number}} opts
   */
  constructor(opts) {
    this.windowMs = opts.windowMs;
    this.max = opts.max;
    /** @type {Map<string, {count: number, windowStart: number}>} */
    this.buckets = new Map();
  }

  allow(key, now = Date.now()) {
    const b = this.buckets.get(key);
    if (!b || now - b.windowStart >= this.windowMs) {
      this.buckets.set(key, { count: 1, windowStart: now });
      return true;
    }
    b.count += 1;
    return b.count <= this.max;
  }

  cleanup(now = Date.now()) {
    for (const [k, b] of this.buckets) {
      if (now - b.windowStart >= this.windowMs * 2) this.buckets.delete(k);
    }
  }
}

const ipRateLimiter = new RateLimiter({ windowMs: IP_RATE_WINDOW_MS, max: IP_RATE_MAX });

function cleanupClient(ws) {
  const client = clients.get(ws);
  if (!client || !client.roomCode) return;

  const room = rooms.get(client.roomCode);
  if (!room) return;

  const other = room.host === ws ? room.guest : room.host;
  safeSend(other, { type: 'peer-left' });

  if (room.host === ws) room.host = null;
  if (room.guest === ws) room.guest = null;

  if (!room.host && !room.guest) {
    rooms.delete(client.roomCode);
  }
}

function cleanupRoom(roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return;
  safeSend(room.host, { type: 'room-closed' });
  safeSend(room.guest, { type: 'room-closed' });
  rooms.delete(roomCode);
}

// ============== HTTP SERVER (health) ==============
const server = http.createServer((req, res) => {
  if (req.url === '/health' || req.url === '/') {
    // Minimal response (privacy-first)
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }
  res.writeHead(404);
  res.end();
});

// ============== WEBSOCKET SERVER ==============
const wss = new WebSocket.Server({
  server,
  maxPayload: MAX_MESSAGE_SIZE,
  // verifyClient runs before accepting the WS upgrade.
  verifyClient: (info, done) => {
    try {
      const { req } = info;
      const origin = getOrigin(req);
      if (ALLOWED_ORIGINS.length > 0) {
        if (!origin || !ALLOWED_ORIGINS.includes(origin)) {
          return done(false, 403, 'Forbidden');
        }
      }

      const ip = getClientIp(req);
      if (!ip) {
        // No IP: reject (conservative)
        return done(false, 403, 'Forbidden');
      }
      if (!ipRateLimiter.allow(ip)) {
        return done(false, 429, 'Too Many Requests');
      }

      return done(true);
    } catch (_) {
      return done(false, 400, 'Bad Request');
    }
  }
});

wss.on('connection', (ws) => {
  clients.set(ws, {
    id: randomId(),
    roomCode: null,
    isHost: false,
    msgCount: 0,
    msgWindowStart: Date.now()
  });

  ws.isAlive = true;

  ws.on('pong', () => {
    ws.isAlive = true;
  });

  ws.on('message', (raw) => {
    const client = clients.get(ws);
    if (!client) return;

    // Per-connection rate limit
    const now = Date.now();
    if (now - client.msgWindowStart >= CONN_RATE_WINDOW_MS) {
      client.msgWindowStart = now;
      client.msgCount = 0;
    }
    client.msgCount += 1;
    if (client.msgCount > CONN_RATE_MAX) {
      sendGenericError(ws);
      return;
    }

    // raw is already bounded by ws maxPayload; still keep defensive size check.
    if (typeof raw === 'string' && raw.length > MAX_MESSAGE_SIZE) {
      sendGenericError(ws);
      return;
    }
    if (Buffer.isBuffer(raw) && raw.length > MAX_MESSAGE_SIZE) {
      sendGenericError(ws);
      return;
    }

    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (_) {
      sendGenericError(ws);
      return;
    }

    if (!validateMessageShape(msg)) {
      sendGenericError(ws);
      return;
    }

    switch (msg.type) {
      case 'create': {
        const roomCode = normalizeRoomCode(msg.room);
        if (!isValidRoomCode(roomCode)) {
          sendGenericError(ws);
          return;
        }
        if (rooms.has(roomCode)) {
          sendGenericError(ws);
          return;
        }

        rooms.set(roomCode, {
          host: ws,
          guest: null,
          createdAt: Date.now(),
          seenIds: new BoundedSeenIds({ max: 512, ttlMs: 5 * 60_000 })
        });

        client.roomCode = roomCode;
        client.isHost = true;
        safeSend(ws, { type: 'created', room: roomCode });
        return;
      }

      case 'join': {
        const roomCode = normalizeRoomCode(msg.room);
        const room = rooms.get(roomCode);
        if (!room || !room.host || room.host.readyState !== WebSocket.OPEN) {
          sendGenericError(ws);
          return;
        }
        // Disallow joining if already occupied
        if (room.guest && room.guest.readyState === WebSocket.OPEN) {
          sendGenericError(ws);
          return;
        }
        // Prevent same socket being both peers
        if (room.host === ws) {
          sendGenericError(ws);
          return;
        }

        room.guest = ws;
        client.roomCode = roomCode;
        client.isHost = false;

        safeSend(ws, { type: 'joined', room: roomCode });
        safeSend(room.host, { type: 'peer-joined' });
        return;
      }

      case 'signal': {
        if (!client.roomCode) {
          sendGenericError(ws);
          return;
        }
        const room = rooms.get(client.roomCode);
        if (!room) {
          sendGenericError(ws);
          return;
        }

        // Deduplicate by hashing the signal payload.
        const id = sha256Base64Url22(JSON.stringify(msg.data));
        if (room.seenIds.has(id)) return;
        room.seenIds.add(id);

        const target = room.host === ws ? room.guest : room.host;
        safeSend(target, { type: 'signal', data: msg.data });
        return;
      }

      case 'leave': {
        cleanupClient(ws);
        client.roomCode = null;
        safeSend(ws, { type: 'left' });
        return;
      }

      case 'pong':
        // Application pong is accepted but not required.
        return;

      default:
        sendGenericError(ws);
        return;
    }
  });

  ws.on('close', () => {
    cleanupClient(ws);
  });

  ws.on('error', () => {
    // No logs by policy
  });

  ipRateLimiter.cleanup();
});

// ============== HEARTBEAT ==============
const heartbeatInterval = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      cleanupClient(ws);
      try { ws.terminate(); } catch (_) {}
      continue;
    }
    ws.isAlive = false;
    try { ws.ping(); } catch (_) {}
  }
}, HEARTBEAT_INTERVAL_MS);

// ============== ROOM CLEANUP ==============
const roomCleanupInterval = setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (now - room.createdAt > MAX_ROOM_AGE_MS) {
      cleanupRoom(code);
      continue;
    }

    const hostAlive = room.host && room.host.readyState === WebSocket.OPEN;
    const guestAlive = room.guest && room.guest.readyState === WebSocket.OPEN;
    if (!hostAlive && !guestAlive) {
      rooms.delete(code);
    }
  }
  ipRateLimiter.cleanup(now);
}, 60_000);

// ============== START SERVER ==============
server.listen(PORT);

// ============== GRACEFUL SHUTDOWN ==============
process.on('SIGTERM', () => {
  clearInterval(heartbeatInterval);
  clearInterval(roomCleanupInterval);
  try {
    for (const ws of wss.clients) {
      try { ws.close(); } catch (_) {}
    }
  } catch (_) {}
  try {
    server.close(() => process.exit(0));
    // Force exit if close hangs.
    setTimeout(() => process.exit(0), 2_000).unref();
  } catch (_) {
    process.exit(0);
  }
});
