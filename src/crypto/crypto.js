// ─── HELPERS ──────────────────────────────────────────────────────────────────

export function bufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

export function base64ToBuffer(base64) {
  // Normalise URL-safe base64 just in case
  const normalized = base64.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(normalized)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes.buffer
}

// ─── KEY GENERATION ───────────────────────────────────────────────────────────

export async function generateRSAKeyPair() {
  try {
    return await crypto.subtle.generateKey(
      {
        name: 'RSA-OAEP',
        modulusLength: 4096,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: 'SHA-256',
      },
      true,              // extractable — required so we can export/wrap the private key
      ['encrypt', 'decrypt'],
    )
  } catch (err) {
    throw new Error(`Key generation failed: ${err.message}`)
  }
}

export function generateSalt() {
  return crypto.getRandomValues(new Uint8Array(32))
}

// ─── PASSWORD-BASED KEY DERIVATION ────────────────────────────────────────────
// Derives an AES-GCM key from the user's password + salt via PBKDF2.
// We use AES-GCM (not AES-KW) for wrapping the private key because:
//   - AES-KW requires input length to be a multiple of 8 bytes AND ≥ 24 bytes
//     in a very strict way that varies across browser versions.
//   - AES-GCM is universally supported, adds an authentication tag, and has
//     no alignment restrictions.

export async function deriveWrappingKey(password, salt) {
  try {
    const passwordKey = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(password),
      'PBKDF2',
      false,
      ['deriveKey'],
    )
    return crypto.subtle.deriveKey(
      {
        name: 'PBKDF2',
        salt: typeof salt === 'string' ? base64ToBuffer(salt) : salt,
        iterations: 310_000,
        hash: 'SHA-256',
      },
      passwordKey,
      { name: 'AES-GCM', length: 256 },   // ← AES-GCM, not AES-KW
      false,
      ['encrypt', 'decrypt'],              // ← encrypt/decrypt, not wrap/unwrap
    )
  } catch (err) {
    throw new Error(`Key derivation failed: ${err.message}`)
  }
}

// ─── PRIVATE KEY WRAPPING ─────────────────────────────────────────────────────
// Export the RSA private key as PKCS8, then AES-GCM encrypt the raw bytes.
// Returns a base64 string of: [12-byte IV] + [AES-GCM ciphertext + auth tag]

export async function wrapPrivateKey(privateKey, wrappingKey) {
  try {
    const pkcs8 = await crypto.subtle.exportKey('pkcs8', privateKey)
    const iv    = crypto.getRandomValues(new Uint8Array(12))
    const encrypted = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      wrappingKey,
      pkcs8,
    )
    // Prepend the IV so we can recover it during unwrap
    const combined = new Uint8Array(iv.byteLength + encrypted.byteLength)
    combined.set(iv, 0)
    combined.set(new Uint8Array(encrypted), iv.byteLength)
    return bufferToBase64(combined.buffer)
  } catch (err) {
    throw new Error(`Private key wrapping failed: ${err.message}`)
  }
}

export async function exportPublicKey(publicKey) {
  try {
    const exported = await crypto.subtle.exportKey('spki', publicKey)
    return bufferToBase64(exported)
  } catch (err) {
    throw new Error(`Public key export failed: ${err.message}`)
  }
}

// ─── PRIVATE KEY UNWRAPPING ───────────────────────────────────────────────────
// Reverses wrapPrivateKey: split IV from the blob, AES-GCM decrypt, re-import.

export async function unwrapPrivateKey(wrappedB64, wrappingKey) {
  try {
    const combined = new Uint8Array(base64ToBuffer(wrappedB64))
    const iv       = combined.slice(0, 12)
    const data     = combined.slice(12)
    const pkcs8    = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      wrappingKey,
      data,
    )
    return crypto.subtle.importKey(
      'pkcs8',
      pkcs8,
      { name: 'RSA-OAEP', hash: 'SHA-256' },
      false,             // non-extractable once restored — no need to export again
      ['decrypt'],
    )
  } catch (err) {
    // Most likely cause: wrong password → AES-GCM auth tag mismatch
    throw new Error(`Could not unlock private key. Check your password. (${err.message})`)
  }
}

export async function importPublicKey(publicKeyB64) {
  try {
    return crypto.subtle.importKey(
      'spki',
      base64ToBuffer(publicKeyB64),
      { name: 'RSA-OAEP', hash: 'SHA-256' },
      false,
      ['encrypt'],
    )
  } catch (err) {
    throw new Error(`Public key import failed: ${err.message}`)
  }
}

// ─── MESSAGE ENCRYPTION ───────────────────────────────────────────────────────
// Hybrid encryption:
//   1. Generate a random AES-GCM 256-bit key (messageKey)
//   2. Encrypt plaintext with messageKey → ciphertext
//   3. RSA-OAEP encrypt messageKey for the recipient  → encryptedKey
//   4. RSA-OAEP encrypt messageKey for the sender     → encryptedKeyForSelf
//      (so the sender can re-read their own sent messages)

export async function encryptMessage(plaintext, recipientPublicKey, senderPublicKey) {
  try {
    const messageKey = await crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt'],
    )
    const iv = crypto.getRandomValues(new Uint8Array(12))

    const ciphertextBuf = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      messageKey,
      new TextEncoder().encode(plaintext),
    )

    const rawKey = await crypto.subtle.exportKey('raw', messageKey)

    const [encryptedKey, encryptedKeyForSelf] = await Promise.all([
      crypto.subtle.encrypt({ name: 'RSA-OAEP' }, recipientPublicKey, rawKey),
      crypto.subtle.encrypt({ name: 'RSA-OAEP' }, senderPublicKey,    rawKey),
    ])

    return {
      ciphertext:          bufferToBase64(ciphertextBuf),
      iv:                  bufferToBase64(iv),
      encryptedKey:        bufferToBase64(encryptedKey),
      encryptedKeyForSelf: bufferToBase64(encryptedKeyForSelf),
    }
  } catch (err) {
    throw new Error(`Message encryption failed: ${err.message}`)
  }
}

// ─── MESSAGE DECRYPTION ───────────────────────────────────────────────────────

export async function decryptMessage(ciphertext, iv, encryptedKey, privateKey) {
  try {
    const rawKey = await crypto.subtle.decrypt(
      { name: 'RSA-OAEP' },
      privateKey,
      base64ToBuffer(encryptedKey),
    )
    const messageKey = await crypto.subtle.importKey(
      'raw',
      rawKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['decrypt'],
    )
    const plaintextBuf = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: base64ToBuffer(iv) },
      messageKey,
      base64ToBuffer(ciphertext),
    )
    return new TextDecoder().decode(plaintextBuf)
  } catch (err) {
    throw new Error(`Decryption failed: ${err.message}`)
  }
}

// ─── INDEXEDDB KEY STORAGE ────────────────────────────────────────────────────

const DB_NAME = 'whisperbox_keys'
const STORE   = 'keys'

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = (e) => e.target.result.createObjectStore(STORE, { keyPath: 'id' })
    req.onsuccess = (e) => resolve(e.target.result)
    req.onerror   = (e) => reject(new Error(`IndexedDB open failed: ${e.target.error}`))
  })
}

export async function storeKeys(userId, privateKey, publicKey) {
  try {
    const db = await openDB()
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).put({ id: userId, privateKey, publicKey })
      tx.oncomplete = resolve
      tx.onerror    = (e) => reject(new Error(`Key storage failed: ${e.target.error}`))
    })
  } catch (err) {
    // Non-fatal — keys are still in memory for this session
    console.warn('storeKeys:', err.message)
  }
}

export async function loadKeys(userId) {
  try {
    const db = await openDB()
    return new Promise((resolve, reject) => {
      const tx  = db.transaction(STORE, 'readonly')
      const req = tx.objectStore(STORE).get(userId)
      req.onsuccess = (e) => resolve(e.target.result || null)
      req.onerror   = (e) => reject(new Error(`Key load failed: ${e.target.error}`))
    })
  } catch (err) {
    console.warn('loadKeys:', err.message)
    return null
  }
}

export async function clearKeys(userId) {
  try {
    const db = await openDB()
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).delete(userId)
      tx.oncomplete = resolve
      tx.onerror    = (e) => reject(new Error(`Key clear failed: ${e.target.error}`))
    })
  } catch (err) {
    console.warn('clearKeys:', err.message)
  }
}