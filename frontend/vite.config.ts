import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  build: {
    chunkSizeWarningLimit: 1000, // Aumenta il limite a 1000 kB (default è 500 kB)
    rollupOptions: {
      input: {
        // App utenti (index.html) + pannello admin separato (admin.html → /admin)
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        admin: fileURLToPath(new URL('./admin.html', import.meta.url)),
      },
    },
  },
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['logo.png'],
      manifest: {
        name: 'HQ',
        short_name: 'HQ',
        description: 'HQ — Il tuo gestionale',
        theme_color: '#111111',
        background_color: '#111111',
        display: 'standalone',
        orientation: 'portrait-primary',
        start_url: '/',
        scope: '/',
        lang: 'it',
        categories: ['business', 'finance', 'productivity'],
        // Condividi nell'app: ricevi una foto da un'altra app (Galleria, Vinted…)
        // → la passiamo al SW (sw-share.js) che la mette in cache e apre l'app.
        share_target: {
          action: '/share-target',
          method: 'POST',
          enctype: 'multipart/form-data',
          params: {
            title: 'title',
            text: 'text',
            url: 'url',
            files: [{ name: 'image', accept: ['image/*'] }],
          },
        },
        icons: [
          {
            src: '/logo.png',
            sizes: '192x192',
            type: 'image/png',
          },
          {
            src: '/logo.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any',
          },
          {
            src: '/logo.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        skipWaiting: true,
        clientsClaim: true,
        // Margine di sicurezza: un asset grande (es. logo pesante) non deve far fallire la build.
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
        // Gestori custom: share target (foto condivisa) + notifiche push
        importScripts: ['sw-share.js', 'sw-push.js'],
        globPatterns: ['**/*.{js,css,html,ico,svg,png,woff,woff2}'],
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api/, /^\/auth/, /^\/products/, /^\/team/, /^\/notifications/, /^\/tracking/, /^\/health/, /^\/admin/],
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
