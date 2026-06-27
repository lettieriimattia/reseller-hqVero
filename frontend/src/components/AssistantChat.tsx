// AssistantChat — chatbox "HQ" (BETA · solo admin · solo telefono).
// Barra di scrittura luminosa in basso: l'utente scrive in linguaggio naturale e
// l'assistente (Groq + tool-calling) cerca nel catalogo, aggiunge prodotti, valuta prezzi.
// Microfono = dettatura vocale (Web Speech API). La wake-word "Ehy HQ" arriva in fase 3 (Picovoice).

import { useState, useRef, useEffect, useCallback } from 'react';
import { Sparkles, Send, Mic, X, Loader2, Square, Radio } from 'lucide-react';
import { VoiceRecorder, recordCommand, transcribe, startWakeWord, isRecordingSupported, type WakeWordHandle } from '../lib/voice';

type ApiCall = <T = any>(path: string, opts?: RequestInit) => Promise<{ ok: boolean; data: T; status: number }>;
type Msg = { role: 'user' | 'assistant'; content: string };

interface Props {
  apiCall: ApiCall;
  showToast: (msg: string, type?: 'ok' | 'err' | 'warn') => void;
  onAction: () => void; // refresh magazzino dopo un'azione (es. prodotto aggiunto)
}

// Wake-word "Ehy HQ" (Picovoice): attiva solo se è impostata la access key.
const PICOVOICE_KEY: string = (import.meta.env.VITE_PICOVOICE_ACCESS_KEY as string) || '';

type VoiceState = 'idle' | 'recording' | 'transcribing';

export default function AssistantChat({ apiCall, showToast, onAction }: Props) {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [voiceState, setVoiceState] = useState<VoiceState>('idle');
  const [wakeOn, setWakeOn] = useState(false);
  const recRef = useRef<VoiceRecorder | null>(null);
  const wakeRef = useRef<WakeWordHandle | null>(null);
  const voiceBusyRef = useRef(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const recSupported = isRecordingSupported();

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
    const { ok, data, status } = await apiCall<any>('/api/assistant/message', {
      method: 'POST',
      body: JSON.stringify({ messages: next }),
    });
    setSending(false);
    if (!ok) {
      // Messaggio specifico per capire SUBITO cosa manca (config, permessi, rete...).
      const msg = data?.error
        || (status === 403 ? 'Assistente in beta: per ora solo per gli admin.'
          : status === 503 ? 'Assistente non configurato sul server (manca la chiave Groq).'
          : status === 429 ? 'Troppe richieste, riprova tra un minuto.'
          : status === 401 ? 'Sessione scaduta: rientra e riprova.'
          : !status ? 'Niente connessione: controlla la rete e riprova.'
          : 'Assistente non disponibile, riprova tra poco.');
      setMessages(m => [...m, { role: 'assistant', content: '⚠️ ' + msg }]);
      showToast(msg, 'err');
      return;
    }
    const reply = (data?.reply || '').toString().trim() || 'Fatto.';
    setMessages(m => [...m, { role: 'assistant', content: reply }]);
    // Se ha aggiunto un prodotto, aggiorna il magazzino.
    if (Array.isArray(data?.actions) && data.actions.some((a: any) => a?.tool === 'aggiungi_prodotto' && a?.result?.ok)) {
      onAction();
    }
  }, [messages, sending, apiCall, showToast, onAction]);

  // Riferimento all'ultima send: la callback della wake-word vive a lungo, evitiamo closure stantie.
  const sendRef = useRef(send);
  useEffect(() => { sendRef.current = send; }, [send]);

  // Mic manuale: tocca per parlare, tocca di nuovo per fermare → Whisper → riempie l'input.
  // (Sostituisce la vecchia Web Speech API, che su Safari iOS non esiste.)
  const toggleMic = useCallback(async () => {
    if (!recSupported) { showToast('Microfono non disponibile su questo browser', 'warn'); return; }
    if (voiceBusyRef.current && voiceState !== 'recording') return;

    if (voiceState === 'recording' && recRef.current) {
      voiceBusyRef.current = true;
      setVoiceState('transcribing');
      try {
        const clip = await recRef.current.stop();
        if (clip) {
          const text = await transcribe(apiCall, clip.base64, clip.mime);
          if (text) setInput(prev => (prev ? prev + ' ' : '') + text);
          else showToast('Non ho capito, riprova', 'warn');
        }
      } catch (e: any) {
        showToast(e?.message || 'Trascrizione non riuscita', 'err');
      } finally {
        recRef.current = null;
        setVoiceState('idle');
        voiceBusyRef.current = false;
      }
      return;
    }

    try {
      setOpen(true);
      const rec = new VoiceRecorder();
      await rec.start();
      recRef.current = rec;
      setVoiceState('recording');
    } catch {
      showToast('Permesso microfono negato', 'err');
      setVoiceState('idle');
    }
  }, [recSupported, voiceState, apiCall, showToast]);

  // Wake-word "Ehy HQ": a riconoscimento apre la chat, registra a mani libere,
  // trascrive e invia da solo. Attiva solo se VITE_PICOVOICE_ACCESS_KEY è impostata
  // e i modelli (/picovoice/Ehy_HQ.ppn + porcupine_params.pv) sono raggiungibili.
  useEffect(() => {
    if (!PICOVOICE_KEY || !recSupported) return;
    let cancelled = false;

    const onWake = async () => {
      if (voiceBusyRef.current) return;
      voiceBusyRef.current = true;
      setOpen(true);
      try {
        await wakeRef.current?.pause();
        setVoiceState('recording');
        const clip = await recordCommand();
        setVoiceState('transcribing');
        if (clip) {
          const text = await transcribe(apiCall, clip.base64, clip.mime);
          if (text) { setInput(''); await sendRef.current(text); }
        }
      } catch { /* la wake-word riprende comunque */ }
      finally {
        setVoiceState('idle');
        voiceBusyRef.current = false;
        try { await wakeRef.current?.resume(); } catch { /* noop */ }
      }
    };

    startWakeWord({ accessKey: PICOVOICE_KEY, onWake })
      .then(h => { if (cancelled) { h.stop(); return; } wakeRef.current = h; setWakeOn(true); })
      .catch(() => { /* key/modelli assenti o non validi: wake-word spenta, mic manuale resta ok */ });

    return () => {
      cancelled = true;
      setWakeOn(false);
      const h = wakeRef.current;
      wakeRef.current = null;
      h?.stop();
    };
  }, [recSupported, apiCall]);

  return (
    <>
      {/* Pannello chat (slide-up) — solo telefono. Sotto i modali (z-50), sopra la nav (z-30). */}
      {open && (
        <div className="lg:hidden fixed inset-0 z-[44] flex flex-col justify-end">
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setOpen(false)} />
          <div
            className="relative flex flex-col max-h-[72vh] rounded-t-[28px] border-t border-white/10 bg-[var(--surface)]/95 backdrop-blur-2xl ring-1 ring-white/5 shadow-[0_-24px_80px_-24px_rgba(139,92,246,0.55)]"
            style={{ paddingBottom: 64 }}>
            {/* Grab handle */}
            <div className="mx-auto mt-3 mb-1.5 h-1.5 w-10 rounded-full bg-white/15" />

            <div className="flex items-center justify-between px-6 pt-1.5 pb-3">
              <div className="flex items-center gap-2.5">
                <span className="w-8 h-8 rounded-full bg-gradient-to-br from-violet-500 to-fuchsia-500 flex items-center justify-center shadow-lg shadow-violet-500/30">
                  <Sparkles size={16} className="text-white" />
                </span>
                <div className="flex flex-col leading-none gap-1">
                  <span className="font-bold tracking-tight text-[var(--text)]">HQ</span>
                  <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-violet-400/80">Assistente · beta</span>
                </div>
              </div>
              <button onClick={() => setOpen(false)} aria-label="Chiudi"
                className="text-[var(--text-faint)] hover:text-[var(--text)] p-1.5 rounded-full hover:bg-white/5 transition-colors">
                <X size={20} />
              </button>
            </div>

            <div ref={scrollRef} className="flex-1 overflow-y-auto px-5 py-3 space-y-3.5">
              {messages.length === 0 && (
                <div className="text-sm text-[var(--text-soft)] py-8 text-center leading-relaxed">
                  Ciao! Scrivimi cosa vuoi fare 👇<br />
                  <span className="text-[var(--text-faint)]">es. "aggiungi le Jordan 4 Bred taglia 42 a 180€" oppure "quanto vale la Dunk Panda?"</span>
                </div>
              )}
              {messages.map((m, i) => (
                <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                  <div className={`max-w-[82%] px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap rounded-2xl ${
                    m.role === 'user'
                      ? 'bg-gradient-to-br from-violet-500 to-violet-600 text-white rounded-br-md shadow-lg shadow-violet-500/25'
                      : 'bg-white/[0.05] border border-white/10 text-[var(--text)] rounded-bl-md'
                  }`}>{m.content}</div>
                </div>
              ))}
              {sending && (
                <div className="flex justify-start">
                  <div className="px-4 py-3 rounded-2xl rounded-bl-md bg-white/[0.05] border border-white/10">
                    <Loader2 size={16} className="animate-spin text-violet-400" />
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Barra di scrittura luminosa in basso — solo telefono. Sopra la bottom-nav (z-30) e
          sopra il pannello chat (z-44), ma sotto i modali (z-50). Quando la chat è aperta
          la barra scende in fondo (la nav è coperta dal pannello). */}
      <div className="lg:hidden fixed left-3 right-3 z-[45]" style={{ bottom: open ? 'calc(env(safe-area-inset-bottom, 0px) + 12px)' : 'calc(env(safe-area-inset-bottom, 0px) + 72px)' }}>
        <div className="relative rounded-full p-px bg-gradient-to-r from-violet-500/90 via-fuchsia-500/90 to-violet-500/90 shadow-[0_8px_44px_-8px_rgba(139,92,246,0.7)]">
          <div className="flex items-center gap-2 rounded-full bg-[var(--surface)]/90 backdrop-blur-xl border border-white/5 pl-4 pr-1.5 py-2">
            {wakeOn
              ? <Radio size={16} className="text-violet-400 shrink-0 animate-pulse" aria-label="In ascolto di Ehy HQ" />
              : <Sparkles size={16} className="text-violet-400 shrink-0" />}
            <input
              value={input}
              onChange={e => setInput(e.target.value)}
              onFocus={() => setOpen(true)}
              onKeyDown={e => { if (e.key === 'Enter') send(input); }}
              placeholder={
                voiceState === 'recording' ? 'Sto ascoltando… tocca ⏹ per fermare'
                : voiceState === 'transcribing' ? 'Trascrivo…'
                : wakeOn ? 'Chiedi a HQ…  o di’ "Ehy HQ"'
                : 'Chiedi a HQ...'}
              disabled={voiceState !== 'idle'}
              className="flex-1 bg-transparent outline-none text-sm text-[var(--text)] placeholder:text-[var(--text-faint)] min-w-0 disabled:opacity-70" />
            <button onClick={toggleMic} disabled={voiceState === 'transcribing'}
              aria-label={voiceState === 'recording' ? 'Ferma e trascrivi' : 'Detta a voce'}
              className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 transition-colors disabled:opacity-50 ${
                voiceState === 'recording' ? 'bg-red-500/15 text-red-400 ring-1 ring-red-500/30 animate-pulse' : 'text-[var(--text-soft)] hover:text-[var(--text)] hover:bg-white/5'
              }`}>
              {voiceState === 'recording' ? <Square size={16} className="fill-current" />
                : voiceState === 'transcribing' ? <Loader2 size={16} className="animate-spin" />
                : <Mic size={18} />}
            </button>
            <button onClick={() => send(input)} disabled={sending || !input.trim()} aria-label="Invia"
              className="w-9 h-9 rounded-full flex items-center justify-center shrink-0 bg-gradient-to-br from-violet-500 to-violet-600 text-white shadow-lg shadow-violet-500/30 transition-all hover:from-violet-400 hover:to-violet-500 disabled:opacity-40 disabled:shadow-none disabled:cursor-not-allowed">
              {sending ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
