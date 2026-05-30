import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 5173,
    proxy: {
      '/auth':          { target: 'https://localhost:3000', secure: false, changeOrigin: true },
      '/products':      { target: 'https://localhost:3000', secure: false, changeOrigin: true },
      '/team':          { target: 'https://localhost:3000', secure: false, changeOrigin: true },
      '/warehouses':    { target: 'https://localhost:3000', secure: false, changeOrigin: true },
      '/api':           { target: 'https://localhost:3000', secure: false, changeOrigin: true },
      '/notifications': { target: 'https://localhost:3000', secure: false, changeOrigin: true },
      '/tracking':      { target: 'https://localhost:3000', secure: false, changeOrigin: true },
      '/health':        { target: 'https://localhost:3000', secure: false, changeOrigin: true },
    },
  },
})
