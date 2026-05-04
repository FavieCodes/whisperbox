import { create } from 'zustand'
import { messagesAPI, usersAPI, getWsUrl } from '../api/api.js'
import { encryptMessage, decryptMessage, importPublicKey } from '../crypto/crypto.js'

// ── Module-level singletons ───────────────────────────────────────────────────
let _wsInstance    = null
let _wsListenerFn  = null
let _inboxInflight = false

const useMessageStore = create((set, get) => ({
  conversations:    {},
  conversationList: [],
  activeUserId:     null,
  isLoading:        false,
  isSending:        false,
  error:            null,
  wsStatus:         'idle', // 'idle' | 'connecting' | 'connected' | 'disconnected'

  // ── WEBSOCKET ──────────────────────────────────────────────────────────────
  connectWS: (token, privateKey, onIncoming) => {
    // Reuse an existing live socket — just swap the callback
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
          // Normalise field names from server
          const normalised = {
            ...msg,
            sender_id:    msg.sender_id    ?? msg.from_user_id,
            recipient_id: msg.recipient_id ?? msg.to_user_id,
          }
          let plaintext    = null
          let decryptError = true
          // Try both key fields — incoming messages use encryptedKey
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
      set({ conversationList: Array.isArray(data) ? data : [] })
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

  // ── LOAD CONVERSATION ──────────────────────────────────────────────────────
  loadConversation: async (contactId, privateKey) => {
    set({ isLoading: true, activeUserId: contactId })
    try {
      const { data } = await messagesAPI.getMessages(contactId)
      // API returns newest-first — reverse to get chronological order
      const raw = Array.isArray(data) ? [...data].reverse() : []

      const decrypted = await Promise.all(raw.map(async (msg) => {
        // Normalise field names FIRST so sender_id is always set
        const normalised = {
          ...msg,
          sender_id:    msg.sender_id    ?? msg.from_user_id,
          recipient_id: msg.recipient_id ?? msg.to_user_id,
        }

        // Try both key fields: encryptedKey (for recipient), encryptedKeyForSelf (for sender)
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
      }))

      set((s) => ({
        conversations: { ...s.conversations, [contactId]: decrypted },
        isLoading: false,
      }))
    } catch (e) {
      console.error('[loadConversation]', e.message)
      set({ isLoading: false })
    }
  },

  // ── SEND MESSAGE ───────────────────────────────────────────────────────────
  // FIX: Always use REST API as primary send path for reliability.
  // The WebSocket is for receiving real-time messages, not the guaranteed send path.
  sendMessage: async (recipientId, plaintext, myPrivateKey, myPublicKey, myId) => {
    if (!plaintext.trim()) return { success: false }
    set({ isSending: true, error: null })
    try {
      const { data: keyData }  = await usersAPI.getPublicKey(recipientId)
      const recipientPublicKey = await importPublicKey(keyData.public_key)
      const payload            = await encryptMessage(plaintext, recipientPublicKey, myPublicKey)

      // Always send via REST — server persists it and delivers via WS to recipient
      const { data: sentMsg } = await messagesAPI.send(recipientId, payload)

      // Build the optimistic message using the real server-assigned ID
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

      set((s) => ({
        conversations: {
          ...s.conversations,
          [recipientId]: [...(s.conversations[recipientId] ?? []), newMsg],
        },
        isSending: false,
      }))

      // Also refresh the conversation list so this conversation bubbles to top
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
      // Deduplicate by ID
      if (existing.some((m) => m.id === normalised.id)) return s
      // Bubble the sender to top of conversation list
      const listEntry = s.conversationList.find((c) => (c.user_id || c.id) === senderId)
      const newList = listEntry
        ? [
            { ...listEntry, last_message_at: normalised.created_at },
            ...s.conversationList.filter((c) => (c.user_id || c.id) !== senderId),
          ]
        : s.conversationList
      return {
        conversations:    { ...s.conversations, [senderId]: [...existing, normalised] },
        conversationList: newList,
      }
    })
  },

  setActiveUser: (id) => set({ activeUserId: id }),
  clearError:    ()   => set({ error: null }),
}))

export default useMessageStore