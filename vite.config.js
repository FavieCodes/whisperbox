import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],

  server: {
    proxy: {
      // REST API 
      '/auth':          { target: 'https://whisperbox.koyeb.app', changeOrigin: true, secure: true },
      '/users':         { target: 'https://whisperbox.koyeb.app', changeOrigin: true, secure: true },
      '/messages':      { target: 'https://whisperbox.koyeb.app', changeOrigin: true, secure: true },
      '/conversations': { target: 'https://whisperbox.koyeb.app', changeOrigin: true, secure: true },

      // WebSocket
      '/ws': {
        target:      'wss://whisperbox.koyeb.app',
        changeOrigin: true,
        secure:       true,
        ws:           true,   
      },
    },
  },
})