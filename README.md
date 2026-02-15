# Optio Chat

Privacy-focused P2P chat over WebRTC.

The signal server only connects peers — it does not store messages, logs, or chat history.  
After connection, most traffic flows directly between browsers.

Messages are protected by WebRTC transport encryption (DTLS) plus Optio’s experimental multi-layer classical cipher system.

---

## Why This Exists

Modern chat platforms rely heavily on centralized infrastructure.  
Even with encryption, metadata often leaks: who talks to whom, when, and how frequently.

Optio Chat explores a lighter model:

- direct browser-to-browser communication
- minimal server trust
- no persistent logs or stored messages

It’s privacy-oriented, simple, and educational.

---

## Features

- **Direct P2P Messaging** — Browser-to-browser after signaling
- **Experimental Cipher Layer** — Multi-layer classical cipher stack on top of DTLS
- **No Persistent Logs** — Signal server does not store chat data or logs
- **Connection Diagnostics Panel** — Visibility into connection health
- **Duplicate Message Detection** — Helps detect retransmits or glitches
- **Latency Monitoring** — Basic connection quality feedback
- **Privacy-Friendly STUN** — Uses non-Google public STUN infrastructure

---

## Architecture

