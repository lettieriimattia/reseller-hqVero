// AssistantChat — chatbox "HQ" (BETA · solo admin · solo telefono).
// Barra di scrittura luminosa in basso: l'utente scrive in linguaggio naturale e
// l'assistente (Groq + tool-calling) cerca nel catalogo, aggiunge prodotti, valuta prezzi.
// Microfono = dettatura vocale (Web Speech API). La wake-word "Ehy HQ" arriva in fase 3 (Picovoice).

import { useState, useRef, useEffect, useCallback } from 'react';
import { Sparkles, Send, Mic, X, Loader2 } from 'lucide-react';

type ApiCall = <T = any>(path: string, opts?: RequestInit) => Promise<{ ok: boolean; data: T; status: number }>;
type Msg = { role: 'user' | 'assistant'; content: string };

interface Props {
  apiCall: ApiCall;
  showToast: (msg: string, type?: 'ok' | 'err' | 'warn') => void;
  onAction: () => void; // refresh magazzino dopo un'azione (es. prodotto aggiunto)
}

// Riconoscimento vocale del browser (Chrome/Edge). Tipizzazione leggera.
const SpeechRec: any = (typeof window !== 'undefined') && ((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition);

export default function AssistantChat({ apiCall, showToast, onAction }: Props) {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [listening, setListening] = useState(false);
  const recRef = useRef<any>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open && scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, open, sending]);

  const send = useCallback(async (text: string) => {
    const t = text.trim();
    if (!t || sending) return;
    const next: Msg[] = [...messages, { role: 'user', content: t }];
    setMessages(next);
    setInput('');
    setSending(true);
    const { ok, data } = await apiCall<any>('/assistant/message', {
      method: 'POST',
      body: JSON.stringify({ messages: next }),
    });
    setSending(false);
    if (!ok) { showToast(data?.error || 'Assistente non disponibile', 'err'); return; }
    const reply = (data?.reply || '').toString().trim() || 'Fatto.';
    setMessages(m => [...m, { role: 'assistant', content: reply }]);
    // Se ha aggiunto un prodotto, aggiorna il magazzino.
    if (Array.isArray(data?.actions) && data.actions.some((a: any) => a?.tool === 'aggiungi_prodotto' && a?.result?.ok)) {
      onAction();
    }
  }, [messages, sending, apiCall, showToast, onAction]);

  const toggleMic = () => {
    if (!SpeechRec) { showToast('Dettatura non supportata su questo browser', 'warn'); return; }
    if (listening) { recRef.current?.stop(); return; }
    const rec = new SpeechRec();
    rec.lang = 'it-IT';
    rec.interimResults = true;
    rec.continuous = false;
    rec.onresult = (e: any) => {
      const txt = Array.from(e.results).map((r: any) => r[0].transcript).join('');
      setInput(txt);
    };
    rec.onend = () => setListening(false);
    rec.onerror = () => setListening(false);
    recRef.current = rec;
    setListening(true);
    setOpen(true);
    try { rec.start(); } catch { setListening(false); }
  };

  return (
    <>
      {/* Pannello chat (slide-up) — solo telefono. Sotto i modali (z-50), sopra la nav (z-30). */}
      {open && (
        <div className="lg:hidden fixed inset-0 z-[44] flex flex-col justify-end">
          <div className="absolute inset-0 bg-black/40" onClick={() => setOpen(false)} />
          <div className="relative bg-[var(--surface)] border-t border-[#8b5cf6]/30 rounded-t-3xl max-h-[72vh] flex flex-col shadow-[0_-8px_40px_-12px_rgba(139,92,246,0.5)]" style={{ paddingBottom: 64 }}>
            <div className="flex items-center justify-between px-5 pt-4 pb-2">
              <div className="flex items-center gap-2">
                <span className="w-7 h-7 rounded-full bg-[#8b5cf6]/15 flex items-center justify-center"><Sparkles size={15} className="text-[#8b5cf6]" /></span>
                <span className="font-black text-[var(--text)]">HQ <span className="text-[10px] font-bold text-[#8b5cf6] align-top">beta</span></span>
              </div>
              <button onClick={() => setOpen(false)} className="text-[var(--text-faint)] p-1"><X size={20} /></button>
            </div>

            <div ref={scrollRef} className="flex-1 overflow-y-auto px-5 py-2 space-y-3">
              {messages.length === 0 && (
                <div className="text-sm text-[var(--text-soft)] py-6 text-center">
                  Ciao! Scrivimi cosa vuoi fare 👇<br />
                  <span className="text-[var(--text-faint)]">es. "aggiungi le Jordan 4 Bred taglia 42 a 180€" oppure "quanto vale la Dunk Panda?"</span>
                </div>
              )}
              {messages.map((m, i) => (
                <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                  <div className={`max-w-[80%] px-3.5 py-2 rounded-2xl text-sm whitespace-pre-wrap ${
                    m.role === 'user' ? 'bg-[#8b5cf6] text-white rounded-br-md' : 'bg-[var(--fill)] text-[var(--text)] rounded-bl-md'
                  }`}>{m.content}</div>
                </div>
              ))}
              {sending && (
                <div className="flex justify-start"><div className="px-3.5 py-2 rounded-2xl bg-[var(--fill)]"><Loader2 size={16} className="animate-spin text-[#8b5cf6]" /></div></div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Barra di scrittura luminosa in basso — solo telefono. Sopra la bottom-nav (z-30) e
          sopra il pannello chat (z-44), ma sotto i modali (z-50). Quando la chat è aperta
          la barra scende in fondo (la nav è coperta dal pannello). */}
      <div className="lg:hidden fixed left-3 right-3 z-[45]" style={{ bottom: open ? 'calc(env(safe-area-inset-bottom, 0px) + 12px)' : 'calc(env(safe-area-inset-bottom, 0px) + 72px)' }}>
        <div className="relative rounded-full p-[1.5px] bg-gradient-to-r from-[#8b5cf6] via-fuchsia-500 to-[#8b5cf6] shadow-[0_0_24px_-4px_rgba(139,92,246,0.7)]">
          <div className="flex items-center gap-2 rounded-full bg-[var(--surface)] pl-4 pr-1.5 py-1.5">
            <Sparkles size={16} className="text-[#8b5cf6] shrink-0" />
            <input
              value={input}
              onChange={e => setInput(e.target.value)}
              onFocus={() => setOpen(true)}
              onKeyDown={e => { if (e.key === 'Enter') send(input); }}
              placeholder="Chiedi a HQ..."
              className="flex-1 bg-transparent outline-none text-sm text-[var(--text)] placeholder:text-[var(--text-faint)] min-w-0" />
            <button onClick={toggleMic} aria-label="Detta"
              className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 ${listening ? 'bg-red-500/20 text-red-400 animate-pulse' : 'text-[var(--text-soft)]'}`}>
              <Mic size={18} />
            </button>
            <button onClick={() => send(input)} disabled={sending || !input.trim()} aria-label="Invia"
              className="w-9 h-9 rounded-full bg-[#8b5cf6] text-white flex items-center justify-center shrink-0 disabled:opacity-40">
              {sending ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
