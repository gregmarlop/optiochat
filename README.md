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
- **Duplicate Detection** — SHA-256-based deduplication to filter duplicate messages
- **Latency Monitoring** — Warns if connection shows suspicious delays
- **STUN via Framasoft** — No Google, French non-profit, GDPR compliant

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

```bash
# Clone
git clone https://github.com/gregmarlop/optiochat.git
cd optio-chat

# Install dependency
npm install ws

# Run signal server
node optio-signal-server.js
```

Or with Homebrew (macOS):

```bash
brew install node
npm install ws
node optio-signal-server.js
```

## Usage

1. Start the signal server:

```bash
node optio-signal-server.js
```

2. Open `optio-chat.html` in browser

3. Enter a secret key (share this with your peer beforehand)

4. Click **CREATE ROOM** → get a code like `sol-luna-42`

5. Share the room code with your peer

6. Peer opens the same page, enters same secret key, clicks **JOIN ROOM**

7. Connected. Chat is now P2P encrypted.

## Understanding the Status Panel

### Connection

| Field    | Description              |
|----------|--------------------------|
| Mode     | P2P Direct or Relayed    |
| Protocol | WebRTC                   |
| Latency  | Ping time to peer        |
| Uptime   | Time since connected     |

### Security

| Check              | Meaning                              |
|--------------------|--------------------------------------|
| ✓ Peer IP stable   | Peer hasn't changed IP mid-session   |
| ✓ No decrypt errors| All messages decrypted successfully  |
| ✓ No replay        | No duplicate messages detected       |
| ✓ Latency normal   | No suspicious delays (< 200ms)       |

### Badges

| Badge | Meaning                          |
|-------|----------------------------------|
| OK    | All checks passing               |
| WARN  | 1-2 anomalies detected           |
| RISK  | 3+ anomalies, connection suspect |

### Crypto

| Field    | Description                        |
|----------|------------------------------------|
| Messages | Count of sent/received             |
| Bytes    | Traffic volume                     |
| Order    | Cipher sequence derived from key   |

## What the Server Sees

```
Room code: "sol-luna-42"
Offer A:   "xK9mN2bQ8v..." (encrypted garbage)
Offer B:   "aB3cD4eF5g..." (encrypted garbage)
Messages:  NOTHING (they go P2P)
```

The server is blind. It moves bytes it cannot read.

## Deploy

### Signal Server (Fly.io - free)

```bash
fly launch
fly deploy
```

### Client (GitHub Pages - free)

Just push `optio-chat.html`. It's static.

Update `SIGNAL_SERVER` in the HTML to point to your deployed server:

```javascript
const SIGNAL_SERVER = 'wss://your-server.fly.dev';
```

## Security & Privacy Requirements

### ⚠️ PRODUCTION DEPLOYMENT - REQUIRED

1. **HTTPS/WSS Only**
   - **NEVER** use HTTP or WS in production
   - WebRTC requires secure contexts (HTTPS) for getUserMedia and other APIs
   - Signal server must use WSS (WebSocket Secure)
   - Use a reverse proxy (nginx, Caddy) with automatic HTTPS

2. **Reverse Proxy Configuration**
   ```nginx
   # nginx example
   server {
       listen 443 ssl http2;
       server_name chat.example.com;
       
       ssl_certificate /path/to/cert.pem;
       ssl_certificate_key /path/to/key.pem;
       
       # HSTS (force HTTPS for 1 year)
       add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
       
       # CSP for client HTML
       add_header Content-Security-Policy "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self' wss://chat.example.com" always;
       
       location / {
           proxy_pass http://localhost:3000;
           proxy_http_version 1.1;
           proxy_set_header Upgrade $http_upgrade;
           proxy_set_header Connection "upgrade";
           proxy_set_header Host $host;
           proxy_set_header X-Real-IP $remote_addr;
       }
   }
   ```

3. **Origin Security**
   ```bash
   # Allow specific origins (optional)
   ALLOWED_ORIGINS="https://chat.example.com,https://chat2.example.com" node optio-signal-server.js
   ```
   - Default: same-origin only
   - Production: set explicit allowlist

4. **TURN Configuration**
   - Configure TURN servers with short-lived credentials
   - **NEVER** hardcode TURN credentials in client HTML
   - Use a TURN REST API for dynamic credential generation
   - Example: coturn with time-limited credentials

   ```javascript
   // DO NOT hardcode credentials
   // Instead, fetch from your backend
   const iceServers = [
       { urls: 'stun:stun.framasoft.org' },
       // Fetch TURN credentials from your secure API
       await fetchTurnCredentials()
   ];
   ```

5. **Content Security Policy (CSP)**
   Serve the HTML file with these headers:
   ```
   Content-Security-Policy: default-src 'self'; 
                           script-src 'self' 'unsafe-inline'; 
                           style-src 'self' 'unsafe-inline'; 
                           connect-src 'self' wss://your-server.com;
                           img-src 'self' data:;
                           font-src 'self';
   ```

### Privacy Features

- ✅ **No tracking or analytics**
- ✅ **No logging of:**
  - Message contents
  - Encryption keys
  - SDP/ICE payloads
  - IP addresses
  - User identifiers
- ✅ **Minimal debug logging** (disabled by default)
- ✅ **Generic error messages** (no information leakage)

### Security Features

- ✅ **SHA-256 deduplication** (collision-resistant)
- ✅ **Bounded LRU cache** (prevents memory exhaustion)
- ✅ **IP-based rate limiting** (100 connections/min per IP)
- ✅ **Per-connection rate limiting** (50 messages/sec)
- ✅ **Origin validation** (same-origin or allowlist)
- ✅ **Message size limits** (64KB max)
- ✅ **Strict schema validation**
- ✅ **Ping/pong correlation** (nonce-based, prevents replay)

### Environment Variables

```bash
PORT=3000                    # Server port (default: 3000)
DEBUG=1                      # Enable debug logging (default: off)
ALLOWED_ORIGINS="https://..." # Origin allowlist (default: same-origin)
```

## Limitations

- **NAT traversal** — Some restrictive networks may block P2P. STUN helps but isn't magic.
- **Both online** — No offline messages. Both peers must be connected.
- **Browser only** — No mobile app (yet).
- **Room codes** — Short-lived. If both disconnect, room disappears.

## Security Model

| Layer              | Protection                                   |
|--------------------|----------------------------------------------|
| Transport          | WebRTC DTLS (standard)                       |
| Application        | Optio 12-layer classical ciphers             |
| Key Derivation     | PBKDF-style with 10,000 iterations           |
| Salt               | Random per message (never same output)       |
| Metadata           | Minimal—server only sees room code           |

**This is not military-grade crypto.** It's a labyrinth of classical ciphers. Strong enough for casual privacy, interesting enough to understand.

## Ethical Use

This tool is for:

- Private conversations between  parties
- Learning about P2P and encryption
- Situations where you don't trust central servers

## How It Works

1. Both peers connect to signal server with room code
2. Server passes encrypted WebRTC offers between them
3. Browsers establish direct P2P connection
4. Server connection closed
5. All messages encrypted with Optio before sending
6. Decrypted on arrival using shared secret key
7. Status panel monitors connection health in real-time

## License

MIT License

## Author

Gregori M.
