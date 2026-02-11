/**
 * Optio Signal Server v2.0
 * Servidor de señalización robusto para WebRTC
 * 
 * Features:
 * - Validación estricta de mensajes
 * - Room state machine (EMPTY → ONE_PEER → TWO_PEERS)
 * - Heartbeat + cleanup
 * - Rate limiting
 * - Idempotencia (duplicados ignorados)
 * 
 * MIT License - Copyright (c) 2026 Gregori M.
 */

const WebSocket = require('ws');

// ============== CONFIG ==============
const PORT = process.env.PORT || 3000;
const HEARTBEAT_INTERVAL = 25000;  // 25s
const HEARTBEAT_TIMEOUT = 35000;   // 35s sin respuesta = dead
const MAX_MESSAGE_SIZE = 65536;    // 64KB
const RATE_LIMIT_WINDOW = 1000;    // 1 segundo
const RATE_LIMIT_MAX = 50;         // max mensajes por ventana
const MAX_ROOM_AGE = 3600000;      // 1 hora max por sala

// ============== STATE ==============
const rooms = new Map();
// Room structure: { host: ws, guest: ws, state: 'ONE'|'TWO', createdAt: Date, seenIds: Set }

// Client metadata (WeakMap para no memory leak)
const clients = new WeakMap();
// Client structure: { roomCode: string, isHost: bool, lastPong: Date, msgCount: number, msgWindowStart: Date }

// ============== HELPERS ==============
function log(level, msg, data = {}) {
    if (process.env.DEBUG) {
        console.log(JSON.stringify({ 
            ts: new Date().toISOString(), 
            level, 
            msg, 
            ...data 
        }));
    }
}

function generateId() {
    return Math.random().toString(36).substring(2, 10);
}

function validateMessage(data) {
    if (!data || typeof data !== 'object') return { valid: false, error: 'Invalid JSON' };
    if (!data.type || typeof data.type !== 'string') return { valid: false, error: 'Missing type' };
    
    const validTypes = ['create', 'join', 'signal', 'leave', 'pong'];
    if (!validTypes.includes(data.type)) return { valid: false, error: 'Unknown type' };
    
    if (data.type === 'create' || data.type === 'join') {
        if (!data.room || typeof data.room !== 'string') return { valid: false, error: 'Missing room' };
        if (data.room.length > 50) return { valid: false, error: 'Room too long' };
    }
    
    if (data.type === 'signal') {
        if (!data.data) return { valid: false, error: 'Missing signal data' };
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

function cleanupRoom(roomCode) {
    const room = rooms.get(roomCode);
    if (!room) return;
    
    // Notificar a peers restantes
    [room.host, room.guest].forEach(ws => {
        if (ws && ws.readyState === WebSocket.OPEN) {
            try {
                ws.send(JSON.stringify({ type: 'room-closed' }));
            } catch (e) {}
        }
    });
    
    rooms.delete(roomCode);
    log('info', 'Room cleaned up', { roomCode });
}

function cleanupClient(ws) {
    const client = clients.get(ws);
    if (!client || !client.roomCode) return;
    
    const room = rooms.get(client.roomCode);
    if (!room) return;
    
    // Notificar al otro peer
    const other = room.host === ws ? room.guest : room.host;
    if (other && other.readyState === WebSocket.OPEN) {
        try {
            other.send(JSON.stringify({ type: 'peer-left' }));
        } catch (e) {}
    }
    
    // Actualizar estado de sala
    if (room.host === ws) room.host = null;
    if (room.guest === ws) room.guest = null;
    
    // Si sala vacía, limpiar
    if (!room.host && !room.guest) {
        rooms.delete(client.roomCode);
        log('info', 'Room deleted (empty)', { roomCode: client.roomCode });
    } else {
        room.state = 'ONE';
    }
}

// ============== SERVER ==============
const wss = new WebSocket.Server({ 
    port: PORT,
    maxPayload: MAX_MESSAGE_SIZE
});

console.log(`
 ▒█████   ██▓███  ▄▄▄█████▓ ██▓ ▒█████  
▒██▒  ██▒▓██░  ██▒▓  ██▒ ▓▒▓██▒▒██▒  ██▒
▒██░  ██▒▓██░ ██▓▒▒ ▓██░ ▒░▒██▒▒██░  ██▒
▒██   ██░▒██▄█▓▒ ▒░ ▓██▓ ░ ░██░▒██   ██░
░ ████▓▒░▒██▒ ░  ░  ▒██▒ ░ ░██░░ ████▓▒░
           SIGNAL SERVER v2.0

[*] Port: ${PORT}
[*] Max message: ${MAX_MESSAGE_SIZE} bytes
[*] Rate limit: ${RATE_LIMIT_MAX} msgs/${RATE_LIMIT_WINDOW}ms
[*] Heartbeat: ${HEARTBEAT_INTERVAL}ms
[*] Debug: ${process.env.DEBUG ? 'ON' : 'OFF (set DEBUG=1)'}
`);

wss.on('connection', (ws) => {
    // Inicializar metadata del cliente
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
        
        // Rate limiting
        if (!checkRateLimit(client)) {
            ws.send(JSON.stringify({ type: 'error', message: 'Rate limited' }));
            log('warn', 'Rate limited', { clientId: client.id });
            return;
        }
        
        // Parse
        let msg;
        try {
            msg = JSON.parse(rawData.toString());
        } catch (e) {
            ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' }));
            return;
        }
        
        // Validate
        const validation = validateMessage(msg);
        if (!validation.valid) {
            ws.send(JSON.stringify({ type: 'error', message: validation.error }));
            log('warn', 'Invalid message', { error: validation.error, clientId: client.id });
            return;
        }
        
        log('debug', 'Message received', { type: msg.type, clientId: client.id });

        switch (msg.type) {
            case 'create': {
                const roomCode = msg.room.toLowerCase().trim();
                
                if (rooms.has(roomCode)) {
                    ws.send(JSON.stringify({ type: 'error', message: 'Room exists' }));
                    return;
                }
                
                rooms.set(roomCode, {
                    host: ws,
                    guest: null,
                    state: 'ONE',
                    createdAt: Date.now(),
                    seenIds: new Set()
                });
                
                client.roomCode = roomCode;
                client.isHost = true;
                
                ws.send(JSON.stringify({ type: 'created', room: roomCode }));
                log('info', 'Room created', { roomCode, clientId: client.id });
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
                    ws.send(JSON.stringify({ type: 'error', message: 'Room full' }));
                    return;
                }
                
                room.guest = ws;
                room.state = 'TWO';
                
                client.roomCode = roomCode;
                client.isHost = false;
                
                ws.send(JSON.stringify({ type: 'joined', room: roomCode }));
                
                // Notificar al host
                if (room.host && room.host.readyState === WebSocket.OPEN) {
                    room.host.send(JSON.stringify({ type: 'peer-joined' }));
                }
                
                log('info', 'Peer joined', { roomCode, clientId: client.id });
                break;
            }

            case 'signal': {
                if (!client.roomCode) {
                    ws.send(JSON.stringify({ type: 'error', message: 'Not in room' }));
                    return;
                }
                
                const room = rooms.get(client.roomCode);
                if (!room) return;
                
                // Idempotencia: ignorar duplicados
                const msgId = JSON.stringify(msg.data).substring(0, 100);
                if (room.seenIds.has(msgId)) {
                    log('debug', 'Duplicate signal ignored', { clientId: client.id });
                    return;
                }
                room.seenIds.add(msgId);
                if (room.seenIds.size > 200) {
                    // Limpiar viejos
                    const arr = Array.from(room.seenIds);
                    room.seenIds = new Set(arr.slice(-100));
                }
                
                // Enviar al otro peer
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
                // Respuesta a nuestro ping (redundante con ws.pong pero útil para app)
                client.lastPong = Date.now();
                break;
            }
        }
    });

    ws.on('close', () => {
        cleanupClient(ws);
        log('debug', 'Client disconnected', { clientId: clients.get(ws)?.id });
    });
    
    ws.on('error', (err) => {
        log('error', 'WebSocket error', { error: err.message });
    });
});

// ============== HEARTBEAT ==============
const heartbeatInterval = setInterval(() => {
    wss.clients.forEach((ws) => {
        if (!ws.isAlive) {
            log('debug', 'Terminating dead client');
            cleanupClient(ws);
            return ws.terminate();
        }
        ws.isAlive = false;
        ws.ping();
        
        // También enviar ping a nivel de app
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'ping' }));
        }
    });
}, HEARTBEAT_INTERVAL);

// ============== ROOM CLEANUP ==============
const roomCleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const [code, room] of rooms) {
        // Salas muy viejas
        if (now - room.createdAt > MAX_ROOM_AGE) {
            cleanupRoom(code);
            continue;
        }
        // Salas sin peers activos
        const hostAlive = room.host && room.host.readyState === WebSocket.OPEN;
        const guestAlive = room.guest && room.guest.readyState === WebSocket.OPEN;
        if (!hostAlive && !guestAlive) {
            rooms.delete(code);
            log('info', 'Room cleaned (no peers)', { roomCode: code });
        }
    }
}, 60000);

// ============== GRACEFUL SHUTDOWN ==============
process.on('SIGTERM', () => {
    console.log('\n[*] Shutting down...');
    clearInterval(heartbeatInterval);
    clearInterval(roomCleanupInterval);
    
    wss.clients.forEach(ws => {
        ws.send(JSON.stringify({ type: 'server-shutdown' }));
        ws.close();
    });
    
    wss.close(() => {
        console.log('[*] Server closed');
        process.exit(0);
    });
});
