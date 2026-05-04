# 🔒 WhisperBox

> End-to-end encrypted messaging. The server never sees your plaintext — ever.

---

## Table of Contents

1. [Live Demo](#live-demo)
2. [Quick Start](#quick-start)
3. [Architecture Diagram](#architecture-diagram)
4. [Encryption Flow](#encryption-flow)
5. [Key Management](#key-management)
6. [Security Trade-offs](#security-trade-offs)
7. [Known Limitations](#known-limitations)
8. [Project Structure](#project-structure)
9. [Environment Variables](#environment-variables)
10. [API Reference](#api-reference)

---

## Live Demo

**URL:** _your deployed URL here_

Test accounts (create your own via /register):
- Any username ≥ 3 characters and password ≥ 8 characters will work.

---

## Quick Start

```bash
# Install dependencies
npm install

# Start dev server
npm run dev

# Build for production
npm run build
```

**Runtime dependencies required in your package.json:**
```json
{
  "dependencies": {
    "axios": "^1.6.0",
    "date-fns": "^3.0.0",
    "react": "^18.0.0",
    "react-dom": "^18.0.0",
    "react-router-dom": "^6.0.0",
    "zustand": "^4.0.0"
  }
}
```

**Google Fonts** (add to your `index.html`):
```html
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link href="https://fonts.googleapis.com/css2?family=Syne:wght@700;800&family=DM+Mono:wght@400;500&display=swap" rel="stylesheet" />
```

---

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                        CLIENT (Browser)                         │
│                                                                 │
│  ┌──────────┐   ┌──────────────┐   ┌─────────────────────────┐ │
│  │ AuthPage │   │  ChatPage    │   │   Web Crypto API        │ │
│  │          │   │              │   │                         │ │
│  │ register │   │ send message │──▶│ encryptMessage()        │ │
│  │ login    │   │ recv message │◀──│ decryptMessage()        │ │
│  └────┬─────┘   └──────┬───────┘   │ generateRSAKeyPair()   │ │
│       │                │           │ deriveWrappingKey()     │ │
│  ┌────▼────────────────▼────────┐  └─────────────────────────┘ │
│  │         Zustand Stores       │                               │
│  │  authStore   messageStore    │  ┌─────────────────────────┐ │
│  └────┬─────────────┬───────────┘  │     IndexedDB           │ │
│       │             │              │  (CryptoKey objects)    │ │
│       │             │              │  privateKey, publicKey  │ │
│  ┌────▼─────┐  ┌────▼──────────┐   └─────────────────────────┘ │
│  │  api.js  │  │  WebSocket    │                               │
│  │ (axios)  │  │  (WSS)        │                               │
└──┼──────────┼──┼───────────────┼───────────────────────────────┘
   │ HTTPS    │  │ WSS           │
   ▼          │  ▼               │
┌─────────────────────────────────────────────────────────────────┐
│                    BACKEND  (whisperbox.koyeb.app)              │
│                                                                 │
│  /auth/register   ──▶  store(username, bcrypt(password),       │
│                              public_key, wrapped_private_key,   │
│                              pbkdf2_salt)                       │
│                                                                 │
│  /auth/login      ──▶  verify password, return key blobs       │
│                                                                 │
│  /messages        ──▶  store opaque encrypted blob             │
│                         (server CANNOT decrypt)                 │
│                                                                 │
│  /conversations   ──▶  list conversation partners              │
│                                                                 │
│  WebSocket /ws    ──▶  real-time relay of encrypted frames      │
└─────────────────────────────────────────────────────────────────┘
```

---

## Encryption Flow

### Registration

```
User types password
        │
        ▼
generateSalt()  ──────────────────────────────────────┐
        │                                              │
        ▼                                              ▼
deriveWrappingKey(password, salt)          stored server-side as pbkdf2_salt
  └── PBKDF2 · SHA-256 · 310,000 iters
        │
        ▼
  AES-KW 256-bit wrapping key (never leaves browser)
        │
        ├──────────────────────────────────────────────┐
        │                                              │
        ▼                                              ▼
generateRSAKeyPair()                    wrapPrivateKey(privateKey, wrappingKey)
  └── RSA-OAEP · 4096 bit                └── AES-KW wrap → base64 blob
        │                                              │
        ▼                                              ▼
exportPublicKey()                         sent to server as wrapped_private_key
  └── SPKI → base64                       (server cannot unwrap without password)
        │
        ▼
POST /auth/register ──▶ { public_key, wrapped_private_key, pbkdf2_salt }

After success:
  storeKeys(userId, privateKey, publicKey)  ──▶  IndexedDB (CryptoKey objects)
```

### Sending a Message

```
Sender types: "Hello Alice"
        │
        ▼
fetch Alice's public key from server
        │
        ▼
encryptMessage("Hello Alice", alicePublicKey, senderPublicKey)
  │
  ├── 1. Generate random AES-GCM 256 key (messageKey)
  ├── 2. Generate random 96-bit IV
  ├── 3. AES-GCM encrypt plaintext → ciphertext
  ├── 4. Export messageKey as raw bytes
  ├── 5. RSA-OAEP encrypt rawKey with Alice's public key  → encryptedKey
  └── 6. RSA-OAEP encrypt rawKey with Sender's public key → encryptedKeyForSelf
        │
        ▼
Payload sent to server:
  {
    ciphertext,          // AES-GCM encrypted message
    iv,                  // random IV
    encryptedKey,        // AES key encrypted for Alice (only Alice can decrypt)
    encryptedKeyForSelf  // AES key encrypted for Sender (so sender can re-read)
  }

Server stores this opaque blob — it cannot read ciphertext without Alice's private key.
```

### Receiving / Reading a Message

```
Alice loads conversation:
        │
        ▼
For each message:
  try decryptMessage(ciphertext, iv, encryptedKey, alicePrivateKey)
    └── RSA-OAEP decrypt encryptedKey → rawKey
    └── AES-GCM decrypt ciphertext → plaintext ✓

Sender loads their own sent messages:
  try decryptMessage(ciphertext, iv, encryptedKeyForSelf, senderPrivateKey)
    └── RSA-OAEP decrypt encryptedKeyForSelf → rawKey
    └── AES-GCM decrypt ciphertext → plaintext ✓
```

---

## Key Management

### Private Key — Lifecycle

| Stage | What happens |
|---|---|
| **Registration** | Generated with `crypto.subtle.generateKey` in-browser. Never serialised in plaintext. |
| **Wrapping** | Wrapped with AES-KW key derived from the user's password via PBKDF2 (310,000 iterations). The wrapped blob is sent to the server — the server cannot unwrap it without the user's password. |
| **Storage (session)** | The unwrapped `CryptoKey` object is stored in IndexedDB as a non-extractable key. IndexedDB stores the browser's internal key handle, not raw bytes. |
| **Login** | Server returns the wrapped blob. Client re-derives the wrapping key from the password and unwraps the private key back into memory. |
| **Logout** | `clearKeys(userId)` deletes the IndexedDB entry. The in-memory `CryptoKey` is released. |
| **Never** | The raw private key bytes are never logged, sent over the network, or stored in localStorage/sessionStorage. |

### Public Key — Lifecycle

| Stage | What happens |
|---|---|
| **Registration** | Exported as SPKI → base64, stored on the server under the user's profile. |
| **Usage** | Fetched by other users via `GET /users/{id}/public-key` when they want to send a message. |
| **Trust** | The server is trusted to return the correct public key (TOFU — Trust On First Use model). For higher security, out-of-band key verification could be added. |

### Password / PBKDF2

- Salt: 32 random bytes, generated client-side, stored server-side in plaintext (salts are not secret).
- Iterations: **310,000** — exceeds OWASP 2023 minimum of 210,000.
- Hash: SHA-256.
- Output: AES-KW 256-bit key (used only for wrapping/unwrapping the private key, never for message encryption).

---

## Security Trade-offs

### ✅ What this design gets right

- **Zero-knowledge server**: The server stores only ciphertext and wrapped key blobs. It cannot read any message.
- **Private key never in plaintext**: AES-KW wrapping ensures the raw key bytes are never transmitted or stored unencrypted.
- **Per-message random keys**: Every message uses a freshly generated AES-GCM key and IV. Compromise of one message key does not affect any other.
- **Sender read receipts**: `encryptedKeyForSelf` lets senders re-read their own sent messages without storing plaintext.
- **No localStorage**: Tokens live in-memory only (`_access`, `_refresh` variables in `api.js`). No sensitive data in Web Storage.
- **Transport security**: All HTTP requests use HTTPS; WebSocket uses WSS.

### ⚠️ Deliberate Trade-offs

| Trade-off | Decision | Reason |
|---|---|---|
| **Password = key protection** | If user forgets password, private key is permanently lost | This is the E2EE cost. No "forgot password" that preserves history. A password reset would generate a new key pair and all old messages would be unreadable. |
| **TOFU public key trust** | The server could theoretically serve a malicious public key | Acceptable for a demo. Production would require key transparency / out-of-band fingerprint verification (like Signal's Safety Numbers). |
| **RSA-OAEP 4096 vs ECDH** | RSA-OAEP chosen because the API mandates key blobs in a specific format | ECDH + HKDF would provide forward secrecy per-session; RSA-OAEP does not. |
| **No forward secrecy** | A single long-lived RSA key pair per user | Compromise of the private key exposes all past messages. Signal-style double ratchet would solve this but requires significant additional complexity. |
| **Refresh token in memory** | Token is lost on page refresh (user must re-login) | Deliberate: avoids persistent token storage. `restoreSession()` in `App.jsx` partially mitigates this by calling `/auth/me` with the in-memory refresh token before it expires. |

---

## Known Limitations

1. **No forward secrecy**: Compromise of a user's private key exposes all past messages. A double-ratchet algorithm (as used by Signal) would mitigate this but is out of scope here.

2. **No key verification UI**: Users cannot verify each other's key fingerprints in-app. A malicious server could perform a MITM by substituting public keys. In production, fingerprint display and out-of-band comparison (like WhatsApp's security codes) should be added.

3. **Single device**: The private key is stored in IndexedDB on the device where the account was created. Logging in from a second device re-fetches the wrapped key from the server and unwraps it with the password — this works correctly, but messages sent before the first login on that device may not decrypt if the conversation was loaded before the key was ready.

4. **No message deletion**: There is no API endpoint to delete messages. Sent ciphertext persists on the server indefinitely.

5. **RSA-4096 is slow**: Key generation during registration takes 1–5 seconds on modern hardware. This is expected behaviour, not a bug. A progress indicator is shown.

6. **Session lost on page refresh**: Because tokens are stored only in memory, a hard page refresh requires the user to log in again (unless `/auth/me` succeeds with the still-valid refresh token).

7. **No group messaging**: The current encryption scheme is 1:1 only. Group messaging with E2EE requires a different key distribution approach (e.g. Sender Keys as used by Signal Groups).

8. **Replay attack mitigation**: The server is responsible for replay protection (message IDs and timestamps). The client does not implement additional replay detection. Adding a message sequence number or nonce verification client-side would strengthen this.

---

## Project Structure

```
src/
├── api/
│   └── api.js              # Axios instance, token management, all API calls
├── crypto/
│   └── crypto.js           # All Web Crypto API operations, IndexedDB key storage
├── store/
│   ├── authStore.js         # Zustand: authentication, key lifecycle
│   └── messageStore.js      # Zustand: conversations, WebSocket, send/receive
├── pages/
│   ├── AuthPage.jsx         # Login and register forms
│   ├── AuthPage.css
│   ├── ChatPage.jsx         # Main chat UI
│   └── ChatPage.css
├── styles/
│   └── global.css           # Design tokens, shared component styles
├── App.jsx                  # Router, session restore on mount
└── main.jsx                 # React root
```

---

## Environment Variables

No environment variables are required. The API base URL is hardcoded in `api.js`:

```js
const BASE = 'https://whisperbox.koyeb.app'
```

If you deploy your own backend, update this constant or move it to a `.env` file:

```
VITE_API_BASE=https://your-backend.example.com
```

Then in `api.js`:
```js
const BASE = import.meta.env.VITE_API_BASE
```

---

## API Reference

All endpoints are on `https://whisperbox.koyeb.app`. Interactive docs: https://whisperbox.koyeb.app/docs

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/auth/register` | ✗ | Create account + upload key material |
| POST | `/auth/login` | ✗ | Authenticate, receive tokens + key blobs |
| GET | `/auth/me` | ✓ | Get current user profile + key blobs |
| POST | `/auth/refresh` | ✗ | Refresh access token |
| POST | `/auth/logout` | ✓ | Revoke refresh token (body: `{ refresh_token }`) |
| GET | `/users/search?q=` | ✓ | Search users by username |
| GET | `/users/{id}/public-key` | ✓ | Fetch a user's RSA public key |
| POST | `/messages` | ✓ | Send encrypted message (REST fallback) |
| GET | `/conversations/{id}/messages` | ✓ | Paginated message history |
| GET | `/conversations` | ✓ | List all conversations |
| WS | `/ws?token=` | ✓ | Real-time encrypted message relay |

### WebSocket Frame Formats

**Send a message:**
```json
{
  "type": "message.send",
  "payload": {
    "recipient_id": "<uuid>",
    "payload": {
      "ciphertext": "<base64>",
      "iv": "<base64>",
      "encryptedKey": "<base64>",
      "encryptedKeyForSelf": "<base64>"
    }
  }
}
```

**Receive a message:**
```json
{
  "type": "message.receive",
  "payload": {
    "id": "<uuid>",
    "from_user_id": "<uuid>",
    "to_user_id": "<uuid>",
    "payload": {
      "ciphertext": "<base64>",
      "iv": "<base64>",
      "encryptedKey": "<base64>",
      "encryptedKeyForSelf": "<base64>"
    },
    "created_at": "2024-01-01T00:00:00Z"
  }
}
```

---

## Cryptographic Primitives Summary

| Primitive | Algorithm | Key Size | Purpose |
|---|---|---|---|
| Asymmetric encryption | RSA-OAEP | 4096 bit | Encrypt per-message AES key for recipient and sender |
| Symmetric encryption | AES-GCM | 256 bit | Encrypt message plaintext |
| IV | Random | 96 bit | AES-GCM nonce — fresh per message |
| Key wrapping | AES-KW | 256 bit | Wrap private key for server storage |
| Key derivation | PBKDF2 | — | Derive AES-KW key from user password |
| Hash (PBKDF2) | SHA-256 | — | Pseudorandom function for PBKDF2 |
| Salt | CSPRNG | 256 bit | PBKDF2 salt — unique per user |
| All randomness | `crypto.getRandomValues` | — | Browser CSPRNG — no `Math.random()` used |

---

_Built with React · Zustand · Web Crypto API · Axios · Vite_