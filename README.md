# Optio Chat

P2P encrypted chat over WebRTC. The signal server only connects peers—it never sees your messages. Everything is end-to-end encrypted with Optio's 12-layer classical cipher system.

## Why This Exists

Modern chat apps route everything through central servers. Even with encryption, metadata leaks: who talks to whom, when, how often.

Optio Chat is different. After the initial handshake, messages flow directly between browsers. The server becomes irrelevant. No logs, no history, no metadata.

## Features

- **P2P Direct** — Messages go browser to browser, not through servers
- **12-Layer Encryption** — Classical ciphers (Caesar, Atbash, Vigenère, Substitution) in key-derived order
- **No Logs** — Signal server keeps nothing in memory, writes nothing to disk
- **Live Security Panel** — Real-time monitoring of connection health and anomalies
- **Replay Detection** — Alerts if duplicate messages are detected
- **Latency Monitoring** — Warns if connection shows suspicious delays
- **STUN via Framasoft** — No Google, French non-profit, GDPR compliant
- **TURN Fallback** — Public TURN servers for restrictive networks
- **Perfect Negotiation** — Handles WebRTC glare without hanging
- **Auto Reconnect** — Exponential backoff on connection loss

## Architecture

```
YOU ──► Signal Server ◄── FRIEND
        (sees room code only)
              │
              ▼
        Exchange WebRTC
        offers (encrypted)
              │
              ▼
YOU ◄════════════════════► FRIEND
        Direct P2P
        Encrypted with Optio
        Server out of the loop
```

## Installation

### Local Development

```bash
git clone https://github.com/gregmarlop/optiochat.git
cd optiochat
npm install
node optio-signal-server.js
```

Open `optio-chat.html` in browser.

### Deploy Your Own

#### Signal Server (Fly.io)

```bash
fly launch
fly deploy
```

#### Client (GitHub Pages)

Push to GitHub, enable Pages in Settings.

Update `SIGNAL_SERVER` in the HTML:

```javascript
const SIGNAL_SERVER = 'wss://your-app.fly.dev';
```

## Usage

1. Open the chat page
2. Enter a secret key (share with your peer beforehand)
3. Click **CREATE ROOM** → get a code like `sol-luna-42`
4. Share the room code with your peer
5. Peer enters same secret key, clicks **JOIN ROOM**
6. Connected — chat is now P2P encrypted

## Status Panel

### Connection

| Field      | Description              |
|------------|--------------------------|
| Mode       | P2P Direct or Relayed    |
| ICE        | Connection state         |
| Latency    | Ping time to peer        |
| Uptime     | Time since connected     |
| Reconnects | Number of reconnections  |

### Security

| Check              | Meaning                              |
|--------------------|--------------------------------------|
| ✓ Peer stable      | Peer hasn't changed mid-session      |
| ✓ No decrypt errors| All messages decrypted successfully  |
| ✓ No replay        | No duplicate messages detected       |
| ✓ Latency normal   | No suspicious delays (< 200ms)       |

### Badges

| Badge | Meaning                          |
|-------|----------------------------------|
| OK    | All checks passing               |
| WARN  | 1-2 anomalies detected           |
| RISK  | 3+ anomalies, connection suspect |

## What the Server Sees

```
Room code: "sol-luna-42"
Offer A:   "xK9mN2bQ8v..." (garbage)
Offer B:   "aB3cD4eF5g..." (garbage)
Messages:  NOTHING (P2P)
```

The server is blind. It moves bytes it cannot read.

## Security Model

| Layer              | Protection                                   |
|--------------------|----------------------------------------------|
| Transport          | WebRTC DTLS (standard)                       |
| Application        | Optio 12-layer classical ciphers             |
| Key Derivation     | PBKDF-style with 10,000 iterations           |
| Salt               | Random per message                           |
| Metadata           | Minimal—server only sees room code           |

**This is not military-grade crypto.** It's a labyrinth of classical ciphers. Strong enough for casual privacy, interesting enough to understand.

## Limitations

- **NAT traversal** — Some networks block P2P. TURN helps but isn't magic.
- **Both online** — No offline messages.
- **Browser only** — No mobile app yet.
- **Ephemeral rooms** — Disconnect = room gone.

## How It Works

1. Both peers connect to signal server with room code
2. Server passes encrypted WebRTC offers between them
3. Browsers establish direct P2P connection
4. Server connection closed
5. Messages encrypted with Optio before sending
6. Decrypted on arrival using shared secret key
7. Status panel monitors connection health

## License

MIT License

## Author

Gregori M.
