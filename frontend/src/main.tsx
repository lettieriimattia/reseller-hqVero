import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { registerSW } from 'virtual:pwa-register'

// Registra il Service Worker con ricarica automatica quando disponibile un aggiornamento
registerSW({
  immediate: true,
  onRegistered(r: ServiceWorkerRegistration | undefined) {
    // Controlla aggiornamenti ogni 60 minuti
    if (r) {
      setInterval(() => r.update(), 60 * 60 * 1000);
    }
  },
  onNeedRefresh() {
    // Nuovo SW disponibile — ricarica silenziosamente la pagina
    window.location.reload();
  },
  onOfflineReady() {
    console.log('HQ: app pronta offline');
  },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
