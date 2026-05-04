import React, { useEffect } from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import useAuthStore from './store/authStore.js'
import AuthPage from './pages/AuthPage.jsx'
import ChatPage from './pages/ChatPage.jsx'

function Protected({ children }) {
  const auth = useAuthStore((s) => s.isAuthenticated)
  return auth ? children : <Navigate to="/login" replace />
}

function Public({ children }) {
  const auth = useAuthStore((s) => s.isAuthenticated)
  return auth ? <Navigate to="/chat" replace /> : children
}

export default function App() {
  const restoreSession = useAuthStore((s) => s.restoreSession)

  // On first mount, try to restore a live session from IndexedDB + /auth/me.
  // This is a no-op if no valid session exists.
  useEffect(() => {
    restoreSession()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login"    element={<Public><AuthPage mode="login" /></Public>} />
        <Route path="/register" element={<Public><AuthPage mode="register" /></Public>} />
        <Route path="/chat"     element={<Protected><ChatPage /></Protected>} />
        <Route path="*"         element={<Navigate to="/login" replace />} />
      </Routes>
    </BrowserRouter>
  )
}