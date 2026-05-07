import { create } from 'zustand'
import { messagesAPI, usersAPI, getWsUrl } from '../api/api.js'
import { encryptMessage, decryptMessage, importPublicKey } from '../crypto/crypto.js'

// ── Module-level singletons ───────────────────────────────────────────────────
let _wsInstance    = null
let _wsListenerFn  = null
let _inboxInflight = false

// ── Hidden conversations persistence ─────────────────────────────────────────
const loadHidden = () => {
  try { return new Set(JSON.parse(localStorage.getItem('wb_hidden_convos') || '[]')) }
  catch { return new Set() }
}
const saveHidden = (set) => {
  try { localStorage.setItem('wb_hidden_convos', JSON.stringify([...set])) } catch { /* ignore */ }
}

// ── Pagination config ─────────────────────────────────────────────────────────
const PAGE_SIZE = 30

// ── Decrypt a single raw message ──────────────────────────────────────────────
async function decryptMsg(msg, privateKey) {
  const normalised = {
    ...msg,
    sender_id:    msg.sender_id    ?? msg.from_user_id,
    recipient_id: msg.recipient_id ?? msg.to_user_id,
  }
  for (const keyField of ['encryptedKey', 'encryptedKeyForSelf']) {
    if (!msg.payload?.[keyField]) continue
    try {
      const plaintext = await decryptMessage(
        msg.payload.ciphertext,
        msg.payload.iv,
        msg.payload[keyField],
        privateKey,
      )
      return { ...normalised, plaintext, decryptError: false }
    } catch { /* try next key field */ }
  }
  return { ...normalised, plaintext: null, decryptError: true }
}

const useMessageStore = create((set, get) => ({
  conversations:    {},   
  conversationList: [],
  activeUserId:     null,
  isLoading:        false,
  isSending:        false,
  isLoadingMore:    false, 
  error:            null,
  wsStatus:         'idle',
  unreadCounts:     {},
  hiddenConvos:     loadHidden(),

  // ── Pagination state per conversation ────────────────────────────────────
  
  hasMore:   {},   
  oldestId:  {},   

  // ── WEBSOCKET ──────────────────────────────────────────────────────────────
  connectWS: (token, privateKey, onIncoming) => {
    if (_wsInstance && _wsInstance.readyState <= WebSocket.OPEN) {
      _wsListenerFn = onIncoming
      return _wsInstance
    }

    const url = getWsUrl(token)
    set({ wsStatus: 'connecting' })
    const ws = new WebSocket(url)
    _wsInstance   = ws
    _wsListenerFn = onIncoming

    ws.onopen = () => {
      console.log('[WS] connected')
      set({ wsStatus: 'connected' })
    }

    ws.onclose = () => {
      console.log('[WS] closed')
      if (_wsInstance === ws) {
        _wsInstance   = null
        _wsListenerFn = null
        set({ wsStatus: 'disconnected' })
      }
    }

    ws.onerror = (e) => {
      if (_wsInstance === ws) console.error('[WS] error', e)
    }

    ws.onmessage = async (event) => {
      try {
        const frame = JSON.parse(event.data)
        if (frame.type === 'message.receive') {
          const msg = frame.payload
          const normalised = {
            ...msg,
            sender_id:    msg.sender_id    ?? msg.from_user_id,
            recipient_id: msg.recipient_id ?? msg.to_user_id,
          }
          let plaintext    = null
          let decryptError = true
          for (const keyField of ['encryptedKey', 'encryptedKeyForSelf']) {
            if (!msg.payload?.[keyField]) continue
            try {
              plaintext    = await decryptMessage(
                msg.payload.ciphertext,
                msg.payload.iv,
                msg.payload[keyField],
                privateKey,
              )
              decryptError = false
              break
            } catch { /* try next */ }
          }
          const decorated = { ...normalised, plaintext, decryptError }
          if (_wsListenerFn) _wsListenerFn(decorated)
        }
      } catch (e) { console.error('[WS] parse error', e) }
    }

    return ws
  },

  disconnectWS: () => {
    if (_wsInstance) {
      const ws = _wsInstance
      _wsInstance   = null
      _wsListenerFn = null
      ws.onclose = null
      ws.onerror = null
      try { ws.close() } catch { /* ignore */ }
    }
    set({ wsStatus: 'idle' })
  },

  // ── LOAD INBOX ────────────────────────────────────────────────────────────
  loadInbox: async () => {
    if (_inboxInflight) return
    _inboxInflight = true

    const attempt = async () => {
      const { data } = await messagesAPI.getInbox()
      const list = Array.isArray(data) ? data : []
      set((s) => {
        const newHidden = new Set(s.hiddenConvos)
        list.forEach((c) => {
          const cid = c.id ?? c.user_id
          if (newHidden.has(cid) && c.last_message_at) {
           
          }
        })
        return { conversationList: list }
      })
    }

    const delays = [2000, 4000, 6000, 8000]

    try {
      for (let i = 0; i <= delays.length; i++) {
        try {
          await attempt()
          return
        } catch (e) {
          const status = e.response?.status
          if (status === 500 && i < delays.length) {
            console.warn(`[inbox] 500 — backend cold-starting. Retry ${i + 1}/${delays.length} in ${delays[i] / 1000}s…`)
            await new Promise((r) => setTimeout(r, delays[i]))
          } else {
            if (status !== 500) console.error('[inbox] unexpected error:', status, e.message)
            else console.error('[inbox] all retries exhausted — backend may still be starting. Refresh in a moment.')
            return
          }
        }
      }
    } finally {
      _inboxInflight = false
    }
  },

  // ── LOAD CONVERSATION (initial, most-recent page) ─────────────────────────
  //
  loadConversation: async (contactId, privateKey) => {
    set({ isLoading: true, activeUserId: contactId })
    try {
      const { data } = await messagesAPI.getMessages(contactId)
      // API returns newest-first; 
      const raw = Array.isArray(data) ? [...data].reverse() : []

      const decrypted = await Promise.all(raw.map((msg) => decryptMsg(msg, privateKey)))

      // Oldest message 
      const oldest = decrypted[0]?.id ?? null

      set((s) => ({
        conversations: { ...s.conversations, [contactId]: decrypted },
        hasMore:       { ...s.hasMore,  [contactId]: raw.length >= PAGE_SIZE },
        oldestId:      { ...s.oldestId, [contactId]: oldest },
        isLoading: false,
      }))
    } catch (e) {
      console.error('[loadConversation]', e.message)
      set({ isLoading: false })
    }
  },

  // ── LOAD MORE (older messages — pagination) ───────────────────────────────
 
  loadMoreMessages: async (contactId, privateKey) => {
    const state = get()
    if (
      state.isLoadingMore ||
      !state.hasMore[contactId] ||
      !state.oldestId[contactId]
    ) return

    set({ isLoadingMore: true })
    try {
      const { data } = await messagesAPI.getMessages(contactId, state.oldestId[contactId])
      const raw = Array.isArray(data) ? [...data].reverse() : []

      if (raw.length === 0) {
        // Nothing older
        set((s) => ({
          hasMore:       { ...s.hasMore, [contactId]: false },
          isLoadingMore: false,
        }))
        return
      }

      const decrypted = await Promise.all(raw.map((msg) => decryptMsg(msg, privateKey)))

      // The new oldest id is the first element of the prepended batch
      const newOldest = decrypted[0]?.id ?? state.oldestId[contactId]

      set((s) => {
        const existing = s.conversations[contactId] ?? []
        // Deduplicate: drop any ids that are already in existing
        const existingIds = new Set(existing.map((m) => m.id))
        const fresh = decrypted.filter((m) => !existingIds.has(m.id))

        return {
          conversations: {
            ...s.conversations,
            [contactId]: [...fresh, ...existing],
          },
          hasMore:       { ...s.hasMore,  [contactId]: raw.length >= PAGE_SIZE },
          oldestId:      { ...s.oldestId, [contactId]: newOldest },
          isLoadingMore: false,
        }
      })
    } catch (e) {
      console.error('[loadMoreMessages]', e.message)
      set({ isLoadingMore: false })
    }
  },

  // ── SEND MESSAGE ───────────────────────────────────────────────────────────
  sendMessage: async (recipientId, plaintext, myPrivateKey, myPublicKey, myId) => {
    if (!plaintext.trim()) return { success: false }
    set({ isSending: true, error: null })
    try {
      const { data: keyData }  = await usersAPI.getPublicKey(recipientId)
      const recipientPublicKey = await importPublicKey(keyData.public_key)
      const payload            = await encryptMessage(plaintext, recipientPublicKey, myPublicKey)

      const { data: sentMsg } = await messagesAPI.send(recipientId, payload)

      const newMsg = {
        id:           sentMsg?.id || `temp-${Date.now()}`,
        sender_id:    myId,
        recipient_id: recipientId,
        from_user_id: myId,
        to_user_id:   recipientId,
        payload,
        plaintext,
        decryptError: false,
        created_at:   sentMsg?.created_at || new Date().toISOString(),
      }

      set((s) => {
        const newHidden = new Set(s.hiddenConvos)
        if (newHidden.has(recipientId)) {
          newHidden.delete(recipientId)
          saveHidden(newHidden)
        }

        return {
          conversations: {
            ...s.conversations,
            [recipientId]: [...(s.conversations[recipientId] ?? []), newMsg],
          },
          hiddenConvos: newHidden,
          isSending: false,
        }
      })

      get().loadInbox()
      return { success: true }
    } catch (e) {
      console.error('[sendMessage]', e.message)
      set({ isSending: false, error: 'Failed to send message. Please try again.' })
      return { success: false }
    }
  },

  // ── ADD INCOMING (from WS) ─────────────────────────────────────────────────
  addIncoming: (msg) => {
    const normalised = {
      ...msg,
      sender_id:    msg.sender_id    ?? msg.from_user_id,
      recipient_id: msg.recipient_id ?? msg.to_user_id,
    }
    const senderId = normalised.sender_id
    set((s) => {
      const existing = s.conversations[senderId] ?? []
      if (existing.some((m) => m.id === normalised.id)) return s

      const listEntry = s.conversationList.find((c) => (c.user_id || c.id) === senderId)
      const newList = listEntry
        ? [
            { ...listEntry, last_message_at: normalised.created_at },
            ...s.conversationList.filter((c) => (c.user_id || c.id) !== senderId),
          ]
        : s.conversationList

      const isActive = s.activeUserId === senderId
      const newUnreadCounts = isActive
        ? s.unreadCounts
        : { ...s.unreadCounts, [senderId]: (s.unreadCounts[senderId] ?? 0) + 1 }

      const newHidden = new Set(s.hiddenConvos)
      if (newHidden.has(senderId)) {
        newHidden.delete(senderId)
        saveHidden(newHidden)
      }

      return {
        conversations:    { ...s.conversations, [senderId]: [...existing, normalised] },
        conversationList: newList,
        unreadCounts:     newUnreadCounts,
        hiddenConvos:     newHidden,
      }
    })
  },

  // ── MARK CONVERSATION AS READ ──────────────────────────────────────────────
  markRead: (userId) => {
    set((s) => ({ unreadCounts: { ...s.unreadCounts, [userId]: 0 } }))
  },

  // ── HIDE / UNHIDE CONVERSATION ─────────────────────────────────────────────
  hideConversation: (userId) => {
    set((s) => {
      const newHidden = new Set(s.hiddenConvos)
      newHidden.add(userId)
      saveHidden(newHidden)
      const newActive = s.activeUserId === userId ? null : s.activeUserId
      return { hiddenConvos: newHidden, activeUserId: newActive }
    })
  },

  unhideConversation: (userId) => {
    set((s) => {
      const newHidden = new Set(s.hiddenConvos)
      newHidden.delete(userId)
      saveHidden(newHidden)
      return { hiddenConvos: newHidden }
    })
  },

  setActiveUser: (id) => set({ activeUserId: id }),
  clearError:    ()   => set({ error: null }),
}))

export default useMessageStore
