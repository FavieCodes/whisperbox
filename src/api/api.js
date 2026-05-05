import axios from 'axios'

const BASE = import.meta.env.VITE_API_BASE ?? ''

const api = axios.create({
  baseURL: BASE,
  headers: { 'Content-Type': 'application/json' },
  timeout: 15000,
  withCredentials: false,
})

// ── Token storage ─────────────────────────────────────────────────────────────
let _access  = sessionStorage.getItem('wb_access')  || null
let _refresh = sessionStorage.getItem('wb_refresh') || null

export const setTokens = (a, r) => {
  _access = a; _refresh = r
  if (a) sessionStorage.setItem('wb_access',  a); else sessionStorage.removeItem('wb_access')
  if (r) sessionStorage.setItem('wb_refresh', r); else sessionStorage.removeItem('wb_refresh')
}
export const getAccessToken  = () => _access
export const getRefreshToken = () => _refresh
export const clearTokens     = () => {
  _access = null; _refresh = null
  sessionStorage.removeItem('wb_access')
  sessionStorage.removeItem('wb_refresh')
}

// ── WebSocket URL ─────────────────────────────────────────────────────────────
export function getWsUrl(token) {
  const apiBase = import.meta.env.VITE_API_BASE

  if (apiBase) {
    // Convert http(s):// → ws(s)://
    const wsBase = apiBase.replace(/^https/, 'wss').replace(/^http/, 'ws')
    return `${wsBase}/ws?token=${token}`
  }

  // Local dev 
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${proto}//${window.location.host}/ws?token=${token}`
}

// ── Auth header injector ──────────────────────────────────────────────────────
api.interceptors.request.use((config) => {
  if (_access) config.headers.Authorization = `Bearer ${_access}`
  return config
})

// ── Token-refresh interceptor ─────────────────────────────────────────────────
api.interceptors.response.use(
  (res) => res,
  async (err) => {
    const orig = err.config
    if (err.response?.status === 401 && _refresh && !orig._retry) {
      orig._retry = true
      try {
        const { data } = await axios.post(
          `${BASE}/auth/refresh`,
          { refresh_token: _refresh },
          { headers: { 'Content-Type': 'application/json' } },
        )
        setTokens(data.access_token, _refresh)
        orig.headers.Authorization = `Bearer ${_access}`
        return api(orig)
      } catch {
        clearTokens()
        window.location.href = '/login'
      }
    }
    return Promise.reject(err)
  },
)

export const authAPI = {
  register: (username, password, display_name, public_key, wrapped_private_key, pbkdf2_salt) =>
    api.post('/auth/register', { username, password, display_name, public_key, wrapped_private_key, pbkdf2_salt }),
  login:   (username, password) => api.post('/auth/login',   { username, password }),
  refresh: (refresh_token)      => api.post('/auth/refresh', { refresh_token }),
  logout:  ()                   => api.post('/auth/logout',  { refresh_token: _refresh }),
  me:      ()                   => api.get('/auth/me'),
}

export const usersAPI = {
  search:       (q)      => api.get('/users/search', { params: { q } }),
  getPublicKey: (userId) => api.get(`/users/${userId}/public-key`),
}

export const messagesAPI = {
  send:        (recipientId, payload) => api.post('/messages', { to: recipientId, payload }),
  getMessages: (userId, before)       => api.get(`/conversations/${userId}/messages`, { params: before ? { before } : {} }),
  getInbox:    ()                     => api.get('/conversations'),
}

export default api