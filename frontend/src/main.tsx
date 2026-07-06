import { StrictMode, Component, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

// Rete di sicurezza: se l'app crasha in render, NON lasciamo schermo nero (lo splash è già sparito).
// Mostriamo un messaggio con "Ricarica" e chiudiamo lo splash comunque.
class ErrorBoundary extends Component<{ children: ReactNode }, { hasError: boolean }> {
  constructor(props: { children: ReactNode }) { super(props); this.state = { hasError: false }; }
  static getDerivedStateFromError() { return { hasError: true }; }
  componentDidCatch(err: any) { try { (window as any).__hqHideSplash?.(); } catch {} console.error('App crash:', err); }
  render() {
    if (this.state.hasError) {
      return (
        <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 16, padding: 24, textAlign: 'center', color: '#e9ecef', background: '#0a0b0d', fontFamily: '-apple-system, system-ui, sans-serif' }}>
          <div style={{ fontSize: 34, fontWeight: 800, letterSpacing: '0.04em' }}>HQ</div>
          <p style={{ color: '#9aa0a8', fontSize: 15, maxWidth: 320 }}>Qualcosa è andato storto nel caricamento. Riprova.</p>
          <button onClick={() => window.location.reload()} style={{ padding: '12px 22px', borderRadius: 14, background: '#8397aa', color: '#fff', fontWeight: 700, border: 'none', fontSize: 15 }}>Ricarica</button>
        </div>
      );
    }
    return this.props.children;
  }
}

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
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
)

// App montata → chiudi lo splash SUBITO (al prossimo frame dipinto), senza aspettare il timer.
requestAnimationFrame(() => {
  requestAnimationFrame(() => { (window as any).__hqHideSplash?.(); });
});
