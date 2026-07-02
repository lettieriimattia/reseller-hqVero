import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

// PWA: aggiornamento automatico del service worker
if ('serviceWorker' in navigator) {
  let refreshing = false;

  // Quando il nuovo SW prende controllo, ricarica la pagina (una sola volta)
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!refreshing) {
      refreshing = true;
      // href = href è più affidabile di reload() su Safari standalone
      window.location.href = window.location.href;
    }
  });

  const checkForUpdates = () => {
    navigator.serviceWorker.getRegistration().then(r => r?.update()).catch(() => {});
  };

  // Controlla aggiornamenti una volta all'avvio e poi ogni 60 minuti.
  // NB: NON ricontrolliamo ad ogni ritorno sull'app (focus/visibilitychange):
  // causava ricaricamenti continui che sembravano un "primo accesso" ogni volta.
  setTimeout(checkForUpdates, 3000);
  setInterval(checkForUpdates, 60 * 60 * 1000);
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

// App montata → chiudi lo splash SUBITO (al prossimo frame dipinto), senza aspettare il timer.
requestAnimationFrame(() => {
  requestAnimationFrame(() => { (window as any).__hqHideSplash?.(); });
});
