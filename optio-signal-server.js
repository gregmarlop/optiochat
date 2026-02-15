/**
 * Optio Signal Server v2.1 - Security Hardened
 * Servidor de señalización robusto para WebRTC con mejoras de seguridad y privacidad
 * 
 * Security Features:
 * - SHA-256 deduplication with bounded LRU cache
 * - IP-based and per-connection rate limiting
 * - Origin validation with allowlist
 * - Strict message size and schema validation
 * - Privacy-preserving logging (no sensitive data)
 * - Generic error messages (no info leakage)
 * 
 * Privacy Features:
 * - No tracking or analytics
 * - No logging of message contents, keys, SDP/ICE, or IPs
 * - Minimal debug logging (disabled by default)
 * 
 * MIT License - Copyright (c) 2026 Gregori M.
 */

const http = require('http');
const crypto = require('crypto');
const WebSocket = require('ws');

// ============== CONFIG ==============
const PORT = process.env.PORT || 3000;
const HEARTBEAT_INTERVAL = 25000;
const HEARTBEAT_TIMEOUT = 35000;
const MAX_MESSAGE_SIZE = 65536; // 64KB max message size
const RATE_LIMIT_WINDOW = 1000; // Per-connection rate limit window
const RATE_LIMIT_MAX = 50; // Max messages per window per connection
const IP_RATE_LIMIT_WINDOW = 60000; // IP rate limit window (1 minute)
const IP_RATE_LIMIT_MAX = 100; // Max connections per IP per minute
const MAX_ROOM_AGE = 3600000; // 1 hour
const MAX_SEEN_IDS = 100; // Max deduplication cache size per room
const SEEN_ID_TTL = 300000; // 5 minutes TTL for seen IDs

// Origin allowlist (empty = same-origin only)
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS 
    ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim())
    : [];

// ============== STATE ==============
const rooms = new Map();
const clients = new WeakMap();
const ipRateLimits = new Map(); // IP -> {count, windowStart}

// ============== SECURITY HELPERS ==============

/**
 * Privacy-preserving safe logger
 * Redacts sensitive fields and only logs if DEBUG is enabled
 */
function safeLog(level, msg, data = {}) {
    if (!process.env.DEBUG) return;
    
    // Redact sensitive fields
    const safe = { ...data };
    delete safe.data; // Signal data (SDP/ICE)
    delete safe.sdp;
    delete safe.ice;
    delete safe.key;
    delete safe.secret;
    delete safe.message; // User messages
    delete safe.ip; // IP addresses
    
    console.log(JSON.stringify({ 
        ts: new Date().toISOString(), 
        level, 
        msg, 
        ...safe 
    }));
}

function generateId() {
    return crypto.randomBytes(6).toString('base64url');
}

/**
 * Hash signal data using SHA-256 for collision resistance
 * Returns a 22-character base64url hash suitable for deduplication
 */
function hashSignal(data) {
    const str = JSON.stringify(data);
    return crypto.createHash('sha256')
        .update(str)
        .digest('base64url')
        .slice(0, 22);
}

/**
 * Bounded LRU cache for seen message IDs
 * Automatically removes oldest entries when size exceeds limit
 */
class BoundedSeenIds {
    constructor(maxSize = 100, ttl = 300000) {
        this.maxSize = maxSize;
        this.ttl = ttl;
        this.cache = new Map(); // id -> timestamp
    }
    
    has(id) {
        const timestamp = this.cache.get(id);
        if (!timestamp) return false;
        
        // Check if expired
        if (Date.now() - timestamp > this.ttl) {
            this.cache.delete(id);
            return false;
        }
        return true;
    }
    
    add(id) {
        // Remove expired entries
        const now = Date.now();
        for (const [key, timestamp] of this.cache.entries()) {
            if (now - timestamp > this.ttl) {
                this.cache.delete(key);
            }
        }
        
        // Add new entry
        this.cache.set(id, now);
        
        // Enforce max size (LRU - remove oldest)
        if (this.cache.size > this.maxSize) {
            const firstKey = this.cache.keys().next().value;
            this.cache.delete(firstKey);
        }
    }
    
    get size() {
        return this.cache.size;
    }
}

function validateMessage(data) {
    if (!data || typeof data !== 'object') {
        return { valid: false, error: 'Invalid format' };
    }
    if (!data.type || typeof data.type !== 'string') {
        return { valid: false, error: 'Invalid format' };
    }
    
    const validTypes = ['create', 'join', 'signal', 'leave', 'pong'];
    if (!validTypes.includes(data.type)) {
        return { valid: false, error: 'Invalid request' };
    }
    
    if (data.type === 'create' || data.type === 'join') {
        if (!data.room || typeof data.room !== 'string') {
            return { valid: false, error: 'Invalid format' };
        }
        if (data.room.length > 50 || data.room.length < 3) {
            return { valid: false, error: 'Invalid format' };
        }
        // Only allow alphanumeric and hyphens
        if (!/^[a-z0-9-]+$/.test(data.room)) {
            return { valid: false, error: 'Invalid format' };
        }
    }
    
    if (data.type === 'signal') {
        if (!data.data) {
            return { valid: false, error: 'Invalid format' };
        }
        // Validate signal data structure
        if (typeof data.data !== 'object') {
            return { valid: false, error: 'Invalid format' };
        }
    }
    
    return { valid: true };
}

function checkRateLimit(client) {
    const now = Date.now();
    if (now - client.msgWindowStart > RATE_LIMIT_WINDOW) {
        client.msgWindowStart = now;
        client.msgCount = 0;
    }
    client.msgCount++;
    return client.msgCount <= RATE_LIMIT_MAX;
}

function checkIpRateLimit(ip) {
    const now = Date.now();
    let ipLimit = ipRateLimits.get(ip);
    
    if (!ipLimit || now - ipLimit.windowStart > IP_RATE_LIMIT_WINDOW) {
        ipLimit = { count: 0, windowStart: now };
        ipRateLimits.set(ip, ipLimit);
    }
    
    ipLimit.count++;
    
    // Cleanup old IP entries periodically
    if (ipRateLimits.size > 10000) {
        for (const [key, value] of ipRateLimits.entries()) {
            if (now - value.windowStart > IP_RATE_LIMIT_WINDOW * 2) {
                ipRateLimits.delete(key);
            }
        }
    }
    
    return ipLimit.count <= IP_RATE_LIMIT_MAX;
}

function validateOrigin(req) {
    const origin = req.headers.origin;
    
    // No origin header = same-origin or non-browser client (allow)
    if (!origin) return true;
    
    // If allowlist is empty, only allow same-origin
    if (ALLOWED_ORIGINS.length === 0) {
        const host = req.headers.host;
        try {
            const originUrl = new URL(origin);
            return originUrl.host === host;
        } catch {
            return false;
        }
    }
    
    // Check against allowlist
    return ALLOWED_ORIGINS.includes(origin);
}

function cleanupRoom(roomCode) {
    const room = rooms.get(roomCode);
    if (!room) return;
    
    [room.host, room.guest].forEach(ws => {
        if (ws && ws.readyState === WebSocket.OPEN) {
            try {
                ws.send(JSON.stringify({ type: 'room-closed' }));
            } catch (e) {
                safeLog('warn', 'Failed to send room-closed message', { error: e.message });
            }
        }
    });
    
    rooms.delete(roomCode);
    safeLog('info', 'Room cleaned up', { roomCode });
}

function cleanupClient(ws) {
    const client = clients.get(ws);
    if (!client || !client.roomCode) return;
    
    const room = rooms.get(client.roomCode);
    if (!room) return;
    
    const other = room.host === ws ? room.guest : room.host;
    if (other && other.readyState === WebSocket.OPEN) {
        try {
            other.send(JSON.stringify({ type: 'peer-left' }));
        } catch (e) {
            safeLog('warn', 'Failed to send peer-left message', { error: e.message });
        }
    }
    
    if (room.host === ws) room.host = null;
    if (room.guest === ws) room.guest = null;
    
    if (!room.host && !room.guest) {
        rooms.delete(client.roomCode);
        safeLog('info', 'Room deleted (empty)', { roomCode: client.roomCode });
    } else {
        room.state = 'ONE';
    }
}

// ============== HTTP SERVER (Health Check) ==============
const server = http.createServer((req, res) => {
    if (req.url === '/health' || req.url === '/') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ 
            status: 'ok', 
            rooms: rooms.size,
            uptime: process.uptime()
        }));
    } else {
        res.writeHead(404);
        res.end('Not found');
    }
});

// ============== WEBSOCKET SERVER ==============
const wss = new WebSocket.Server({ 
    server,
    maxPayload: MAX_MESSAGE_SIZE,
    verifyClient: ({ req }) => {
        // Origin validation
        if (!validateOrigin(req)) {
            safeLog('warn', 'Origin validation failed');
            return false;
        }
        
        // IP rate limiting
        const ip = req.socket.remoteAddress;
        if (!checkIpRateLimit(ip)) {
            safeLog('warn', 'IP rate limit exceeded');
            return false;
        }
        
        return true;
    }
});

wss.on('connection', (ws, req) => {
    clients.set(ws, {
        id: generateId(),
        roomCode: null,
        isHost: false,
        lastPong: Date.now(),
        msgCount: 0,
        msgWindowStart: Date.now()
    });
    
    ws.isAlive = true;
    
    ws.on('pong', () => {
        ws.isAlive = true;
        const client = clients.get(ws);
        if (client) client.lastPong = Date.now();
    });

    ws.on('message', (rawData) => {
        const client = clients.get(ws);
        if (!client) return;
        
        // Per-connection rate limiting
        if (!checkRateLimit(client)) {
            ws.send(JSON.stringify({ type: 'error', message: 'Too many requests' }));
            safeLog('warn', 'Rate limited', { clientId: client.id });
            return;
        }
        
        // Parse message
        let msg;
        try {
            msg = JSON.parse(rawData.toString());
        } catch (e) {
            ws.send(JSON.stringify({ type: 'error', message: 'Invalid format' }));
            return;
        }
        
        // Validate message schema
        const validation = validateMessage(msg);
        if (!validation.valid) {
            ws.send(JSON.stringify({ type: 'error', message: validation.error }));
            safeLog('warn', 'Invalid message', { error: validation.error, clientId: client.id });
            return;
        }
        
        safeLog('debug', 'Message received', { type: msg.type, clientId: client.id });

        switch (msg.type) {
            case 'create': {
                const roomCode = msg.room.toLowerCase().trim();
                
                if (rooms.has(roomCode)) {
                    ws.send(JSON.stringify({ type: 'error', message: 'Room unavailable' }));
                    return;
                }
                
                rooms.set(roomCode, {
                    host: ws,
                    guest: null,
                    state: 'ONE',
                    createdAt: Date.now(),
                    seenIds: new BoundedSeenIds(MAX_SEEN_IDS, SEEN_ID_TTL)
                });
                
                client.roomCode = roomCode;
                client.isHost = true;
                
                ws.send(JSON.stringify({ type: 'created', room: roomCode }));
                safeLog('info', 'Room created', { roomCode, clientId: client.id });
                break;
            }

            case 'join': {
                const roomCode = msg.room.toLowerCase().trim();
                const room = rooms.get(roomCode);
                
                if (!room) {
                    ws.send(JSON.stringify({ type: 'error', message: 'Room not found' }));
                    return;
                }
                
                if (room.state === 'TWO') {
                    ws.send(JSON.stringify({ type: 'error', message: 'Room unavailable' }));
                    return;
                }
                
                room.guest = ws;
                room.state = 'TWO';
                
                client.roomCode = roomCode;
                client.isHost = false;
                
                ws.send(JSON.stringify({ type: 'joined', room: roomCode }));
                
                if (room.host && room.host.readyState === WebSocket.OPEN) {
                    room.host.send(JSON.stringify({ type: 'peer-joined' }));
                }
                
                safeLog('info', 'Peer joined', { roomCode, clientId: client.id });
                break;
            }

            case 'signal': {
                if (!client.roomCode) {
                    ws.send(JSON.stringify({ type: 'error', message: 'Not in room' }));
                    return;
                }
                
                const room = rooms.get(client.roomCode);
                if (!room) return;
                
                const msgId = hashSignal(msg.data);
                if (room.seenIds.has(msgId)) {
                    safeLog('debug', 'Duplicate signal ignored', { clientId: client.id });
                    return;
                }
                room.seenIds.add(msgId);
                
                const target = room.host === ws ? room.guest : room.host;
                if (target && target.readyState === WebSocket.OPEN) {
                    target.send(JSON.stringify({ type: 'signal', data: msg.data }));
                }
                break;
            }

            case 'leave': {
                cleanupClient(ws);
                client.roomCode = null;
                ws.send(JSON.stringify({ type: 'left' }));
                break;
            }
            
            case 'pong': {
                client.lastPong = Date.now();
                break;
            }
        }
    });

    ws.on('close', () => {
        const client = clients.get(ws);
        const clientId = client?.id;
        cleanupClient(ws);
        safeLog('debug', 'Client disconnected', { clientId });
    });
    
    ws.on('error', (err) => {
        safeLog('error', 'WebSocket error', { error: err.message });
    });
});

// ============== HEARTBEAT ==============
const heartbeatInterval = setInterval(() => {
    wss.clients.forEach((ws) => {
        if (!ws.isAlive) {
            safeLog('debug', 'Terminating dead client');
            cleanupClient(ws);
            return ws.terminate();
        }
        ws.isAlive = false;
        ws.ping();
        
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'ping' }));
        }
    });
}, HEARTBEAT_INTERVAL);

// ============== ROOM CLEANUP ==============
const roomCleanupInterval = setInterval(() => {
    const now = Date.now();
    const roomsToDelete = [];
    
    for (const [code, room] of rooms) {
        if (now - room.createdAt > MAX_ROOM_AGE) {
            roomsToDelete.push({ code, cleanup: true });
            continue;
        }
        const hostAlive = room.host && room.host.readyState === WebSocket.OPEN;
        const guestAlive = room.guest && room.guest.readyState === WebSocket.OPEN;
        if (!hostAlive && !guestAlive) {
            roomsToDelete.push({ code, cleanup: false });
        }
    }
    
    // Delete rooms after iteration
    roomsToDelete.forEach(({ code, cleanup }) => {
        if (cleanup) {
            cleanupRoom(code);
        } else {
            rooms.delete(code);
            safeLog('info', 'Room cleaned (no peers)', { roomCode: code });
        }
    });
}, 60000);

// ============== START SERVER ==============
server.listen(PORT, () => {
    console.log(`
 ▒█████   ██▓███  ▄▄▄█████▓ ██▓ ▒█████  
▒██▒  ██▒▓██░  ██▒▓  ██▒ ▓▒▓██▒▒██▒  ██▒
▒██░  ██▒▓██░ ██▓▒▒ ▓██░ ▒░▒██▒▒██░  ██▒
▒██   ██░▒██▄█▓▒ ▒░ ▓██▓ ░ ░██░▒██   ██░
░ ████▓▒░▒██▒ ░  ░  ▒██▒ ░ ░██░░ ████▓▒░
           SIGNAL SERVER v2.1

[*] Port: ${PORT}
[*] Health: http://localhost:${PORT}/health
[*] Debug: ${process.env.DEBUG ? 'ON' : 'OFF (set DEBUG=1)'}
[*] Origin checking: ${ALLOWED_ORIGINS.length > 0 ? 'Allowlist' : 'Same-origin'}
[!] WARNING: Use HTTPS/WSS in production
`);
});

// ============== GRACEFUL SHUTDOWN ==============
process.on('SIGTERM', () => {
    console.log('\n[*] Shutting down...');
    clearInterval(heartbeatInterval);
    clearInterval(roomCleanupInterval);
    
    wss.clients.forEach(ws => {
        try {
            ws.send(JSON.stringify({ type: 'server-shutdown' }));
            ws.close();
        } catch (e) {
            safeLog('warn', 'Failed to notify client of shutdown', { error: e.message });
        }
    });
    
    server.close(() => {
        console.log('[*] Server closed');
        process.exit(0);
    });
    
    // Force exit after 5 seconds if graceful shutdown fails
    setTimeout(() => {
        console.log('[*] Forcing shutdown after timeout');
        process.exit(1);
    }, 5000);
});
