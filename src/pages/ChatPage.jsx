import React, { useState, useEffect, useRef } from 'react'
import useAuthStore from '../store/authStore.js'
import useMessageStore from '../store/messageStore.js'
import { usersAPI, getAccessToken } from '../api/api.js'
import { formatDistanceToNow } from 'date-fns'
import './ChatPage.css'

// ── Theme hook ─────────────────────────────────────────────────────────────
function useTheme() {
  const [theme, setTheme] = useState(() => {
    const saved = localStorage.getItem('wb_theme')
    const t = saved || 'dark'
    document.documentElement.setAttribute('data-theme', t)
    return t
  })

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    localStorage.setItem('wb_theme', theme)
  }, [theme])

  const toggle = () => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))
  return { theme, toggle }
}

// ── SVG Icons ──────────────────────────────────────────────────────────────
function SunIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="5"/>
      <line x1="12" y1="1" x2="12" y2="3"/>
      <line x1="12" y1="21" x2="12" y2="23"/>
      <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/>
      <line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/>
      <line x1="1" y1="12" x2="3" y2="12"/>
      <line x1="21" y1="12" x2="23" y2="12"/>
      <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/>
      <line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>
    </svg>
  )
}
function MoonIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
    </svg>
  )
}
function LogoutIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>
      <polyline points="16 17 21 12 16 7"/>
      <line x1="21" y1="12" x2="9" y2="12"/>
    </svg>
  )
}

export default function ChatPage() {
  const { user, privateKey, publicKey, logout } = useAuthStore()
  const {
    conversations, conversationList, activeUserId,
    isLoading, isSending, wsStatus,
    loadInbox, loadConversation, sendMessage, setActiveUser,
    connectWS, disconnectWS, addIncoming,
    error: storeError, clearError,
  } = useMessageStore()

  const { theme, toggle: toggleTheme } = useTheme()

  const [activeContact, setActiveContact] = useState(null)
  const [text,          setText]          = useState('')
  const [searchQuery,   setSearchQuery]   = useState('')
  const [searchResults, setSearchResults] = useState([])
  const [showInfo,      setShowInfo]      = useState(false)
  const [loggingOut,    setLoggingOut]    = useState(false)
  const bottomRef = useRef(null)
  const inputRef  = useRef(null)

  // ── WebSocket + inbox ────────────────────────────────────────────────────
  useEffect(() => {
    const token = getAccessToken()
    if (token && privateKey) {
      connectWS(token, privateKey, (msg) => addIncoming(msg))
    }
    loadInbox()
    return () => disconnectWS()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // ── FIX: Reload active conversation when the page regains focus ──────────
  // This ensures that if the user refreshes or switches tabs, messages reload.
  useEffect(() => {
    const handleFocus = () => {
      loadInbox()
      if (activeUserId && privateKey) {
        loadConversation(activeUserId, privateKey)
      }
    }
    window.addEventListener('focus', handleFocus)
    return () => window.removeEventListener('focus', handleFocus)
  }, [activeUserId, privateKey]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Auto-scroll ──────────────────────────────────────────────────────────
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [conversations, activeUserId])

  // ── User search ──────────────────────────────────────────────────────────
  useEffect(() => {
    if (!searchQuery.trim()) { setSearchResults([]); return }
    const t = setTimeout(async () => {
      try {
        const { data } = await usersAPI.search(searchQuery)
        setSearchResults((data || []).filter((u) => u.id !== user?.id))
      } catch { setSearchResults([]) }
    }, 300)
    return () => clearTimeout(t)
  }, [searchQuery, user?.id])

  // ── Open conversation ─────────────────────────────────────────────────────
  const openConvo = async (contact) => {
    const c = { ...contact, id: contact.id || contact.user_id }
    setActiveContact(c)
    setActiveUser(c.id)
    setSearchQuery('')
    setSearchResults([])
    setShowInfo(false)
    await loadConversation(c.id, privateKey)
    inputRef.current?.focus()
  }

  const openSearchResult = async (result) => {
    try {
      const { data } = await usersAPI.getPublicKey(result.id)
      openConvo({ ...result, public_key: data.public_key })
    } catch { openConvo(result) }
  }

  // ── Send ──────────────────────────────────────────────────────────────────
  const handleSend = async (e) => {
    e.preventDefault()
    if (!text.trim() || !activeContact || isSending) return
    await sendMessage(activeContact.id, text.trim(), privateKey, publicKey, user?.id)
    setText('')
    inputRef.current?.focus()
  }

  const handleKey = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(e) }
  }

  // ── Logout ────────────────────────────────────────────────────────────────
  const handleLogout = async () => {
    setLoggingOut(true)
    await logout()
  }

  const msgs = activeUserId ? (conversations[activeUserId] ?? []) : []

  const wsLabel = {
    idle:         '— Idle',
    connecting:   '⏳ Connecting…',
    connected:    '🟢 Live',
    disconnected: '🔴 Offline — messages will use REST fallback',
  }

  return (
    <div className="chat-root">

      {/* ── SIDEBAR ─────────────────────────────────────────── */}
      <aside className="sidebar">
        <div className="sidebar-header">
          <div className="sidebar-brand">
            <span>🔒</span>
            <span className="brand-name">WhisperBox</span>
          </div>
          <div className="sidebar-header-actions">
            <button className="btn btn-ghost icon-btn" onClick={toggleTheme}
              title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}>
              {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
            </button>
          </div>
        </div>

        <div className="sidebar-user">
          <div className="avatar">{user?.username?.[0]?.toUpperCase()}</div>
          <div className="sidebar-user-info">
            <p className="sidebar-uname">{user?.display_name || user?.username}</p>
            <span className="lock-badge">🔑 E2EE Active</span>
          </div>
        </div>

        {/* WS status */}
        <div className="ws-status-bar">
          <span className="ws-status-label">{wsLabel[wsStatus] ?? wsLabel.idle}</span>
        </div>

        {/* Search */}
        <div className="sidebar-search">
          <input className="input search-input" placeholder="Find users…"
            value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} />
          {searchResults.length > 0 && (
            <div className="search-drop fade-in">
              {searchResults.map((r) => (
                <button key={r.id} className="search-item" onClick={() => openSearchResult(r)}>
                  <div className="avatar av-xs">{r.username[0].toUpperCase()}</div>
                  <div>
                    <p>{r.display_name || r.username}</p>
                    <p className="search-sub">@{r.username}</p>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Conversation list */}
        <div className="sidebar-list">
          <p className="list-label">Conversations</p>
          {conversationList.map((c) => {
            const cid = c.id || c.user_id
            return (
              <button key={cid}
                className={`convo-item ${activeUserId === cid ? 'convo-item--on' : ''}`}
                onClick={() => openConvo(c)}>
                <div className="avatar">{(c.display_name || c.username || '?')[0].toUpperCase()}</div>
                <div className="convo-info">
                  <p className="convo-name">{c.display_name || c.username}</p>
                  <p className="convo-sub">
                    {c.last_message_at
                      ? formatDistanceToNow(new Date(c.last_message_at), { addSuffix: true })
                      : 'tap to open'}
                  </p>
                </div>
                <span className="convo-lock">🔐</span>
              </button>
            )
          })}
          {conversationList.length === 0 && (
            <p className="list-empty">Search for a user above to start messaging.</p>
          )}
        </div>

        {/* Logout — pinned to bottom */}
        <div className="sidebar-footer">
          <button className="btn-logout" onClick={handleLogout} disabled={loggingOut}>
            <LogoutIcon />
            <span>{loggingOut ? 'Logging out…' : 'Log Out'}</span>
          </button>
        </div>
      </aside>

      {/* ── MAIN ─────────────────────────────────────────────── */}
      <main className="chat-main">

        {/* Send-error toast */}
        {storeError && (
          <div className="toast-error fade-in" role="alert">
            <span>⚠ {storeError}</span>
            <button onClick={clearError} className="toast-close">✕</button>
          </div>
        )}

        {activeContact ? (
          <>
            <div className="chat-header">
              <div className="chat-header-left">
                <div className="avatar">
                  {(activeContact.display_name || activeContact.username || '?')[0].toUpperCase()}
                </div>
                <div>
                  <p className="chat-cname">{activeContact.display_name || activeContact.username}</p>
                  <span className="lock-badge">🔒 End-to-end encrypted</span>
                </div>
              </div>
              <button className="btn btn-ghost icon-btn"
                onClick={() => setShowInfo((v) => !v)} title="Encryption info">ℹ</button>
            </div>

            {showInfo && (
              <div className="info-panel fade-in">
                <h4>🔐 Encryption Details</h4>
                <div className="info-row"><span>Scheme</span><span>RSA-OAEP 4096 + AES-GCM 256</span></div>
                <div className="info-row"><span>Key derivation</span><span>PBKDF2 · SHA-256 · 310 000 iters</span></div>
                <div className="info-row"><span>Key storage</span><span>IndexedDB (device-only)</span></div>
                <div className="info-row"><span>Server sees</span><span className="c-accent">Ciphertext only ✓</span></div>
                <div className="info-row"><span>Transport</span><span>TLS 1.3 (HTTPS / WSS)</span></div>
                <p className="info-note">Messages are encrypted in your browser before sending. Your private key never leaves this device.</p>
              </div>
            )}

            <div className="msgs-area">
              {isLoading ? (
                <div className="msgs-mid"><div className="spinner" /><span>Decrypting messages…</span></div>
              ) : msgs.length === 0 ? (
                <div className="msgs-mid fade-in">
                  <span style={{ fontSize: '32px' }}>🔒</span>
                  <p>No messages yet. Say hello!</p>
                  <p className="c-muted" style={{ fontSize: '12px' }}>Messages are end-to-end encrypted.</p>
                </div>
              ) : msgs.map((msg, i) => {
                const senderId = msg.sender_id ?? msg.from_user_id
                const mine     = senderId === user?.id
                return (
                  <div key={msg.id || i}
                    className={`msg-row ${mine ? 'msg-row--mine' : 'msg-row--theirs'} fade-in`}>
                    {!mine && (
                      <div className="avatar av-xs">
                        {(activeContact.username || '?')[0].toUpperCase()}
                      </div>
                    )}
                    <div className={`msg-bubble ${mine ? 'msg-bubble--mine' : 'msg-bubble--theirs'}`}>
                      {msg.decryptError
                        ? <span className="c-danger" style={{ fontStyle: 'italic', fontSize: '12px' }}>⚠ Could not decrypt</span>
                        : <span>{msg.plaintext}</span>
                      }
                      <div className="msg-meta">
                        <span>
                          {msg.created_at
                            ? formatDistanceToNow(new Date(msg.created_at), { addSuffix: true })
                            : 'just now'}
                        </span>
                        <span>🔒</span>
                      </div>
                    </div>
                  </div>
                )
              })}
              <div ref={bottomRef} />
            </div>

            <form className="input-bar" onSubmit={handleSend}>
              <div className="input-wrap">
                <textarea ref={inputRef} className="msg-input"
                  placeholder={`Message ${activeContact.display_name || activeContact.username}… (encrypted)`}
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  onKeyDown={handleKey}
                  rows={1} />
                <span className="input-lock-icon">🔐</span>
              </div>
              <button className="btn btn-primary send-btn" type="submit"
                disabled={!text.trim() || isSending}>
                {isSending ? <div className="spinner" /> : '↑'}
              </button>
            </form>
          </>
        ) : (
          <div className="chat-empty fade-in">
            <span style={{ fontSize: '48px' }}>🔒</span>
            <h2>WhisperBox</h2>
            <p>Select a conversation or search for a user to get started.</p>
            <p className="c-muted" style={{ fontSize: '12px', marginTop: '4px' }}>
              All messages are end-to-end encrypted.<br />
              The server never sees your plaintext.
            </p>
            <div className="empty-badges">
              <span className="lock-badge">🔑 RSA-OAEP 4096</span>
              <span className="lock-badge">🛡 AES-GCM 256</span>
              <span className="lock-badge">✓ Zero-knowledge server</span>
            </div>
          </div>
        )}
      </main>
    </div>
  )
}