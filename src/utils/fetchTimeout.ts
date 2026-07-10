// src/utils/fetchTimeout.ts
// fetch() con timeout (AbortController). Le fonti esterne (KicksDB, StockX) non hanno mai un
// SLA garantito: senza timeout, un provider lento blocca la richiesta chiamante a tempo
// indeterminato — es. la chatbox che cerca una foto durante "aggiungi_prodotto" restava ferma
// finché KicksDB/StockX non rispondevano. Con questo, oltre `timeoutMs` si abortisce e si
// ripiega (il chiamante tratta il timeout come "nessun risultato", mai come crash).
export async function fetchWithTimeout(url: string, opts: RequestInit = {}, timeoutMs = 4000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
