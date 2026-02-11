/**
 * Optio Signal Server
 * Servidor de señalización mínimo para WebRTC
 * 
 * Solo conecta peers. No ve contenido (cifrado con Optio).
 * No guarda nada. Memoria volátil.
 * 
 * MIT License - Copyright (c) 2026 Gregori M.
 */

const WebSocket = require('ws');

const PORT = process.env.PORT || 3000;
const rooms = new Map();

const wss = new WebSocket.Server({ port: PORT });

console.log(`
 ▒█████   ██▓███  ▄▄▄█████▓ ██▓ ▒█████  
▒██▒  ██▒▓██░  ██▒▓  ██▒ ▓▒▓██▒▒██▒  ██▒
▒██░  ██▒▓██░ ██▓▒▒ ▓██░ ▒░▒██▒▒██░  ██▒
▒██   ██░▒██▄█▓▒ ▒░ ▓██▓ ░ ░██░▒██   ██░
░ ████▓▒░▒██▒ ░  ░  ▒██▒ ░ ░██░░ ████▓▒░
           SIGNAL SERVER

[*] Listening on port ${PORT}
[*] No logs. No storage. Just connections.
`);

wss.on('connection', (ws) => {
    let currentRoom = null;

    ws.on('message', (data) => {
        try {
            const msg = JSON.parse(data);

            switch (msg.type) {
                case 'create':
                    // Crear sala
                    currentRoom = msg.room;
                    if (!rooms.has(currentRoom)) {
                        rooms.set(currentRoom, { host: ws, guest: null });
                        ws.send(JSON.stringify({ type: 'created', room: currentRoom }));
                    } else {
                        ws.send(JSON.stringify({ type: 'error', message: 'Room exists' }));
                    }
                    break;

                case 'join':
                    // Unirse a sala
                    currentRoom = msg.room;
                    const room = rooms.get(currentRoom);
                    if (room && room.host && !room.guest) {
                        room.guest = ws;
                        ws.send(JSON.stringify({ type: 'joined', room: currentRoom }));
                        room.host.send(JSON.stringify({ type: 'peer-joined' }));
                    } else if (!room) {
                        ws.send(JSON.stringify({ type: 'error', message: 'Room not found' }));
                    } else {
                        ws.send(JSON.stringify({ type: 'error', message: 'Room full' }));
                    }
                    break;

                case 'signal':
                    // Pasar señal WebRTC al otro peer
                    const r = rooms.get(currentRoom);
                    if (r) {
                        const target = r.host === ws ? r.guest : r.host;
                        if (target && target.readyState === WebSocket.OPEN) {
                            target.send(JSON.stringify({ type: 'signal', data: msg.data }));
                        }
                    }
                    break;
            }
        } catch (e) {
            // Ignore malformed messages
        }
    });

    ws.on('close', () => {
        // Limpiar sala
        if (currentRoom && rooms.has(currentRoom)) {
            const room = rooms.get(currentRoom);
            if (room.host === ws || room.guest === ws) {
                // Notificar al otro
                const other = room.host === ws ? room.guest : room.host;
                if (other && other.readyState === WebSocket.OPEN) {
                    other.send(JSON.stringify({ type: 'peer-left' }));
                }
                rooms.delete(currentRoom);
            }
        }
    });
});

// Limpiar salas vacías cada minuto
setInterval(() => {
    for (const [code, room] of rooms) {
        if ((!room.host || room.host.readyState !== WebSocket.OPEN) &&
            (!room.guest || room.guest.readyState !== WebSocket.OPEN)) {
            rooms.delete(code);
        }
    }
}, 60000);
