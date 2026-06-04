import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { registerSW } from 'virtual:pwa-register'

// Registra il Service Worker con ricarica automatica
const updateSW = registerSW({
  immediate: true,
  onRegistered(r: ServiceWorkerRegistration | undefined) {
    if (r) {
      // Controlla aggiornamenti ogni 30 minuti
      setInterval(() => r.update(), 30 * 60 * 1000);
    }
  },
  onNeedRefresh() {
    // Nuovo SW disponibile — ricarica la pagina
    updateSW(true);
  },
  onOfflineReady() {
    // App pronta per uso offline
  },
});

// Safari PWA: controlla aggiornamenti al focus della finestra
window.addEventListener('focus', () => {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.getRegistration().then(r => r?.update());
  }
});

// Safari PWA: rileva cambio controller (nuovo SW attivo) e ricarica
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    window.location.reload();
  });
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
