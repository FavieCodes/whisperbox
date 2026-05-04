import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// During local development, all requests to /api/* and /ws* are proxied to
// the backend. This avoids CORS errors because the browser sees only one origin
// (localhost:5173). In production, deploy behind a reverse proxy or set the
// backend's CORS policy to allow your domain.

export default defineConfig({
  plugins: [react()],

  server: {
    proxy: {
      // REST API — anything that starts with /auth, /users, /messages, /conversations
      '/auth':          { target: 'https://whisperbox.koyeb.app', changeOrigin: true, secure: true },
      '/users':         { target: 'https://whisperbox.koyeb.app', changeOrigin: true, secure: true },
      '/messages':      { target: 'https://whisperbox.koyeb.app', changeOrigin: true, secure: true },
      '/conversations': { target: 'https://whisperbox.koyeb.app', changeOrigin: true, secure: true },

      // WebSocket
      '/ws': {
        target:      'wss://whisperbox.koyeb.app',
        changeOrigin: true,
        secure:       true,
        ws:           true,   // <-- required for WebSocket proxying
      },
    },
  },
})