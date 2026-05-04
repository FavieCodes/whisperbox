import { create } from 'zustand'
import { authAPI, setTokens, clearTokens, getAccessToken } from '../api/api.js'
import {
  generateRSAKeyPair, generateSalt, deriveWrappingKey,
  wrapPrivateKey, exportPublicKey, unwrapPrivateKey, importPublicKey,
  storeKeys, loadKeys, clearKeys, bufferToBase64,
} from '../crypto/crypto.js'

// ── Parse FastAPI / network errors into a readable string ─────────────────────
function parseApiError(err, fallback) {
  const detail = err.response?.data?.detail
  if (Array.isArray(detail)) {
    return detail.map((e) => {
      const field = e.loc?.slice(1).join('.') || ''
      return field ? `${field}: ${e.msg}` : e.msg
    }).join(' · ')
  }
  if (typeof detail === 'string') return detail
  return err.response?.data?.message || err.message || fallback
}

const useAuthStore = create((set, get) => ({
  user:            null,
  isAuthenticated: false,
  isLoading:       false,
  error:           null,
  privateKey:      null,
  publicKey:       null,

  register: async (username, password, displayName) => {
    set({ isLoading: true, error: null })
    try {
      const keyPair        = await generateRSAKeyPair()
      const salt           = generateSalt()
      const saltB64        = bufferToBase64(salt)
      const wrappingKey    = await deriveWrappingKey(password, salt)
      const wrappedPrivKey = await wrapPrivateKey(keyPair.privateKey, wrappingKey)
      const publicKeyB64   = await exportPublicKey(keyPair.publicKey)

      const { data } = await authAPI.register(
        username, password, displayName || username,
        publicKeyB64, wrappedPrivKey, saltB64,
      )

      setTokens(data.access_token, data.refresh_token)
      await storeKeys(data.user.id, keyPair.privateKey, keyPair.publicKey)

      set({
        user: data.user, isAuthenticated: true, isLoading: false,
        privateKey: keyPair.privateKey, publicKey: keyPair.publicKey,
      })
      return { success: true }
    } catch (err) {
      const isCryptoErr = err.message?.includes('Key ') || err.message?.includes('failed')
      const msg = isCryptoErr ? err.message : parseApiError(err, 'Registration failed')
      set({ isLoading: false, error: msg })
      return { success: false, error: msg }
    }
  },

  login: async (username, password) => {
    set({ isLoading: true, error: null })
    try {
      const { data }    = await authAPI.login(username, password)
      setTokens(data.access_token, data.refresh_token)
      const { user }    = data
      const wrappingKey = await deriveWrappingKey(password, user.pbkdf2_salt)
      const privateKey  = await unwrapPrivateKey(user.wrapped_private_key, wrappingKey)
      const publicKey   = await importPublicKey(user.public_key)
      await storeKeys(user.id, privateKey, publicKey)
      set({ user, isAuthenticated: true, isLoading: false, privateKey, publicKey })
      return { success: true }
    } catch (err) {
      const isCryptoErr = err.message?.includes('Could not unlock') || err.message?.includes('decrypt')
      const msg = isCryptoErr ? 'Incorrect password or corrupted key data.' : parseApiError(err, 'Login failed')
      set({ isLoading: false, error: msg })
      return { success: false, error: msg }
    }
  },

  restoreSession: async () => {
    // Already authenticated in this render cycle — skip
    if (get().isAuthenticated) return

    // No token in sessionStorage means no session to restore
    const token = getAccessToken()
    if (!token) return

    try {
      const { data: user } = await authAPI.me()
      const stored = await loadKeys(user.id)
      if (stored?.privateKey && stored?.publicKey) {
        set({
          user,
          isAuthenticated: true,
          privateKey: stored.privateKey,
          publicKey:  stored.publicKey,
        })
        // FIX: Session is restored — state is valid, ChatPage will now mount
        // and its own useEffect will call loadInbox() + connectWS(), so we
        // don't need to do it here. Returning success is enough.
      }
    } catch { /* stay logged out */ }
  },

  logout: async () => {
    try { await authAPI.logout() } catch { /* non-fatal */ }
    const { user } = get()
    if (user?.id) { try { await clearKeys(user.id) } catch { /* non-fatal */ } }
    clearTokens()
    set({ user: null, isAuthenticated: false, privateKey: null, publicKey: null, error: null })
  },

  clearError: () => set({ error: null }),
}))

export default useAuthStore