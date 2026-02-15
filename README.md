# Optio Chat

An experimental P2P encrypted chat exploring layered cryptographic primitives.

## About This Project

This is a learning project that combines classical and modern cryptography concepts. It's not intended for high-security applications—it's a sandbox for understanding how different encryption layers interact.

The goal: make something that works, teaches, and sparks curiosity.

## Cryptographic Stack

The encryption pipeline chains five layers, each based on a different computational hardness assumption:

```
Plaintext
    │
    ▼
┌─────────────────────────────────────────────────────────┐
│  Layer 1: AES-256-GCM                                   │
│  ─────────────────────                                  │
│  Symmetric authenticated encryption.                    │
│  Key derived via PBKDF2 (100,000 iterations).           │
│  Security relies on the difficulty of brute-forcing     │
│  a 256-bit key space (~2^256 operations).               │
└─────────────────────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────────────────────┐
│  Layer 2: LWE (Learning With Errors)                    │
│  ───────────────────────────────────                    │
│  Lattice-based cryptographic primitive.                 │
│  Security reduces to the Shortest Vector Problem (SVP). │
│  Believed to be resistant to quantum attacks.           │
│  This implementation is simplified for educational use. │
└─────────────────────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────────────────────┐
│  Layer 3: MQ (Multivariate Quadratic)                   │
│  ─────────────────────────────────────                  │
│  Based on solving systems of quadratic equations        │
│  over finite fields. The general MQ problem is NP-hard. │
│  Used here as a non-linear mixing layer.                │
└─────────────────────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────────────────────┐
│  Layer 4: Subset Sum                                    │
│  ───────────────────                                    │
│  Classic NP-complete problem: find a subset of numbers  │
│  that sums to a target value. Used here for encoding.   │
│  Complexity grows exponentially with set size.          │
└─────────────────────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────────────────────┐
│  Layer 5: Optio (Classical Ciphers)                     │
│  ──────────────────────────────────                     │
│  A chain of historical ciphers: Caesar, Atbash,         │
│  Vigenère, and substitution. Order derived from key.    │
│  Not secure alone—included as an educational callback   │
│  to pre-modern cryptography.                            │
└─────────────────────────────────────────────────────────┘
    │
    ▼
Ciphertext
```

## Computational Hardness Reference

| Layer | Underlying Problem | Complexity Class | Quantum Resistance |
|-------|-------------------|------------------|-------------------|
| AES-256-GCM | Key exhaustion | O(2^256) | Reduced to O(2^128) via Grover |
| LWE | Shortest Vector Problem | Believed hard | Yes (post-quantum candidate) |
| MQ | Multivariate quadratic | NP-hard | Yes |
| Subset Sum | Subset sum decision | NP-complete | Partially |
| Optio | Frequency analysis | Polynomial | N/A |

## Architecture

```
┌─────────┐                              ┌─────────┐
│  User A │                              │  User B │
└────┬────┘                              └────┬────┘
     │                                        │
     │  1. Connect to signal server           │
     ▼                                        ▼
┌─────────────────────────────────────────────────────┐
│                  Signal Server                       │
│  • Facilitates WebRTC handshake                     │
│  • Sees only: room codes, encrypted SDP offers      │
│  • Stores nothing, logs nothing                     │
└─────────────────────────────────────────────────────┘
     │                                        │
     │  2. Exchange encrypted offers          │
     │◄──────────────────────────────────────►│
     │                                        │
     │  3. Establish P2P connection           │
     ▼                                        ▼
┌─────────────────────────────────────────────────────┐
│              Direct P2P (WebRTC)                     │
│  • Server no longer involved                        │
│  • All messages: 5-layer encrypted                  │
│  • Transport: DTLS (additional layer)               │
└─────────────────────────────────────────────────────┘
```

## Educational Notes

### Why Multiple Layers?

Defense in depth. If one layer has an undiscovered weakness, others remain. This is overkill for a chat app—but instructive.

### Why Include Classical Ciphers?

Historical perspective. Caesar, Vigenère, and substitution ciphers dominated cryptography for centuries. Including them shows how far the field has evolved.

### Why Lattice-Based Crypto?

Quantum computers threaten RSA and ECC. Lattice problems (like LWE) are leading candidates for post-quantum standards. NIST selected CRYSTALS-Kyber (LWE-based) in 2022.

### Is This Actually Secure?

The AES layer alone provides strong security. The other layers add complexity and educational value, but haven't undergone formal cryptanalysis. 

**Do not use this for anything sensitive.**

## Installation

```bash
git clone https://github.com/gregmarlop/optiochat.git
cd optiochat
npm install
node optio-signal-server.js
```

Open `optio-chat.html` in a browser.

## Usage

1. Enter a shared secret key
2. One peer creates a room → receives a code
3. Share the code with your peer
4. Peer joins with the same secret key
5. Chat directly, P2P

## Further Reading

- **AES**: [FIPS 197](https://csrc.nist.gov/publications/detail/fips/197/final)
- **LWE**: Regev, O. (2005). "On Lattices, Learning with Errors, and Cryptography"
- **MQ**: Garey & Johnson (1979). "Computers and Intractability"
- **Subset Sum**: Karp's 21 NP-complete problems (1972)
- **Classical Ciphers**: Singh, S. "The Code Book"

## Limitations

- Simplified implementations (not production-grade)
- No formal security proofs
- Browser-only
- Ephemeral rooms (no persistence)

## License

MIT License

## Author

Gregori M.

---

*Built for curiosity, not for secrets.*
