# Optio Chat

P2P encrypted chat. 5 layers of mathematical problems.

## Encryption Stack

```
Message
   ↓
AES-256-GCM ─────────── Military-grade, unbreakable
   ↓
LWE ─────────────────── Learning With Errors, post-quantum
   ↓
MQ ──────────────────── Multivariate Quadratic, NP-hard
   ↓
Subset Sum ──────────── NP-complete
   ↓
Optio ───────────────── Classical cipher labyrinth
   ↓
Transmission
```

## What the Attacker Sees

Optio's chaotic output. Looks breakable. It's a trap.

## What's Behind It

| Layer | Problem | Status |
|-------|---------|--------|
| AES-256-GCM | 2^256 brute force | Impossible |
| LWE | Shortest vector in lattices | Unsolved, quantum-resistant |
| MQ | Multivariate quadratic equations | NP-hard |
| Subset Sum | Find subset with target sum | NP-complete |
| Optio | 12 classical ciphers | The decoy |

The code is public. The math is public. Solving it is not.

## Architecture

```
YOU ──► Signal Server ◄── FRIEND
        (sees room code only)
              ↓
        Exchange WebRTC offers
              ↓
YOU ◄════════════════════► FRIEND
        Direct P2P
        5-layer encryption
        Server gone
```

## Install

```bash
git clone https://github.com/gregmarlop/optiochat.git
cd optiochat
npm install
node optio-signal-server.js
```

Open `optio-chat.html` in browser.

## Usage

1. Enter secret key
2. CREATE ROOM → get code
3. Share code with peer
4. Peer joins with same key
5. Chat

## Security

- P2P direct (no server relay)
- No logs
- STUN via Framasoft (GDPR)
- TURN fallback for NAT
- Replay detection
- Latency monitoring

## License

MIT

## Author

Gregori M.
