import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg', 'apple-touch-icon.svg', 'icon-192.svg', 'icon-512.svg'],
      manifest: {
        name: 'ResellerHQ',
        short_name: 'HQ',
        description: 'Gestionale professionale per reseller',
        theme_color: '#111111',
        background_color: '#080808',
        display: 'standalone',
        orientation: 'portrait-primary',
        start_url: '/',
        scope: '/',
        lang: 'it',
        categories: ['business', 'finance', 'productivity'],
        icons: [
          {
            src: '/icon-192.svg',
            sizes: '192x192',
            type: 'image/svg+xml',
          },
          {
            src: '/icon-512.svg',
            sizes: '512x512',
            type: 'image/svg+xml',
            purpose: 'any',
          },
          {
            src: '/icon-512.svg',
            sizes: '512x512',
            type: 'image/svg+xml',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,ico,svg,woff,woff2}'],
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api/, /^\/auth/, /^\/products/, /^\/team/, /^\/notifications/, /^\/tracking/, /^\/health/],
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/api\.pokemontcg\.io\/.*/i,
            handler: 'NetworkFirst',
            options: {
              cacheName: 'pokemon-api',
              expiration: { maxEntries: 50, maxAgeSeconds: 86400 },
            },
          },
        ],
      },
      devOptions: {
        enabled: false,
      },
    }),
  ],
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
