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
    navigator.serviceWorker.getRegistration().then(r => r?.update());
  };

  // Controlla 2 secondi dopo l'avvio (SW già registrato a quel punto)
  setTimeout(checkForUpdates, 2000);

  // Controlla ogni 5 minuti
  setInterval(checkForUpdates, 5 * 60 * 1000);

  // Controlla quando l'app torna visibile (chiave per Safari PWA)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') checkForUpdates();
  });
  window.addEventListener('focus', checkForUpdates);
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
