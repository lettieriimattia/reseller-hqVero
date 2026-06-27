// AssistantChat — chatbox "HQ" (BETA · solo admin · solo telefono).
// Barra di scrittura luminosa in basso: l'utente scrive in linguaggio naturale e
// l'assistente (Groq + tool-calling) cerca nel catalogo, aggiunge prodotti, valuta prezzi.
// Microfono = dettatura vocale (Web Speech API). La wake-word "Ehy HQ" arriva in fase 3 (Picovoice).

import { useState, useRef, useEffect, useCallback } from 'react';
import { Sparkles, Send, Mic, X, Loader2, Square, Radio } from 'lucide-react';
import { recordCommand, transcribe, startWakeWord, isRecordingSupported, type WakeWordHandle } from '../lib/voice';

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
  // La conversazione resta finché non chiudi l'app (sessionStorage = si svuota alla chiusura).
  const [messages, setMessages] = useState<Msg[]>(() => {
    try { const s = sessionStorage.getItem('hq_chat'); return s ? JSON.parse(s) : []; } catch { return []; }
  });
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [voiceState, setVoiceState] = useState<VoiceState>('idle');
  const [wakeOn, setWakeOn] = useState(false);
  const [convo, setConvo] = useState(false); // modalità conversazione continua (mani libere)
  const wakeRef = useRef<WakeWordHandle | null>(null);
  const voiceBusyRef = useRef(false);
  const convoRef = useRef(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const recSupported = isRecordingSupported();

  useEffect(() => {
    if (open && scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, open, sending]);

  // Persisti la conversazione per la sessione (ultimi 60 messaggi).
  useEffect(() => {
    try { sessionStorage.setItem('hq_chat', JSON.stringify(messages.slice(-60))); } catch { /* storage pieno */ }
  }, [messages]);

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

  // MODALITÀ CONVERSAZIONE (mani libere): registra → quando fai una pausa l'IA capisce che
  // hai finito, trascrive (Whisper) e INVIA il comando, poi resta in ascolto per il prossimo.
  // Tocca il mic una volta per avviare, di nuovo per fermare. (Web Speech API rimossa: su iOS
  // non esiste; qui registriamo e trascriviamo lato server.)
  const stopConvo = useCallback(() => {
    convoRef.current = false;
    setConvo(false);
    setVoiceState('idle');
  }, []);

  const runConvoLoop = useCallback(async () => {
    while (convoRef.current) {
      setVoiceState('recording');
      let clip: { base64: string; mime: string } | null = null;
      try {
        clip = await recordCommand();           // si ferma da sola alla pausa
      } catch {
        showToast('Permesso microfono negato', 'err');
        stopConvo();
        return;
      }
      if (!convoRef.current) break;
      if (!clip) continue;                       // solo silenzio: continua ad ascoltare
      setVoiceState('transcribing');
      let text = '';
      try { text = await transcribe(apiCall, clip.base64, clip.mime); } catch { /* riprova al giro dopo */ }
      setVoiceState('idle');
      const t = text.trim();
      if (t) await sendRef.current(t);           // esegue il comando, poi il while riprende ad ascoltare
    }
  }, [apiCall, showToast, stopConvo]);

  const toggleMic = useCallback(() => {
    if (convoRef.current) { stopConvo(); return; }
    if (!recSupported) { showToast('Microfono non disponibile su questo browser', 'warn'); return; }
    setOpen(true);
    convoRef.current = true;
    setConvo(true);
    runConvoLoop();
  }, [recSupported, runConvoLoop, stopConvo, showToast]);

  // Ferma la conversazione se il pannello viene chiuso.
  useEffect(() => { if (!open && convoRef.current) stopConvo(); }, [open, stopConvo]);

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

  // Barra di scrittura/voce (riusata: ancorata nel pannello quando aperto, flottante quando chiuso).
  const bar = (
    <div className="relative rounded-full p-px bg-gradient-to-r from-violet-500/90 via-fuchsia-500/90 to-violet-500/90 shadow-[0_8px_44px_-8px_rgba(107,84,198,0.7)]">
      <div className="flex items-center gap-2 rounded-full bg-[var(--surface)]/90 backdrop-blur-xl border border-white/5 pl-4 pr-1.5 py-2">
        {convo
          ? <Radio size={16} className="text-red-400 shrink-0 animate-pulse" aria-label="In conversazione" />
          : wakeOn
            ? <Radio size={16} className="text-violet-400 shrink-0 animate-pulse" aria-label="In ascolto di Ehy HQ" />
            : <Sparkles size={16} className="text-violet-400 shrink-0" />}
        <input
          value={input}
          onChange={e => setInput(e.target.value)}
          onFocus={() => setOpen(true)}
          onKeyDown={e => { if (e.key === 'Enter') send(input); }}
          placeholder={
            convo ? (voiceState === 'transcribing' ? 'Trascrivo…' : 'Parla pure… faccio una pausa e invio')
            : sending ? 'Eseguo…'
            : wakeOn ? 'Chiedi a HQ…  o di’ "Ehy HQ"'
            : 'Chiedi a HQ...'}
          disabled={convo}
          className="flex-1 bg-transparent outline-none text-sm text-[var(--text)] placeholder:text-[var(--text-faint)] min-w-0 disabled:opacity-70" />
        <button onClick={toggleMic}
          aria-label={convo ? 'Ferma conversazione' : 'Parla con HQ (conversazione)'}
          className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 transition-colors ${
            convo ? 'bg-red-500/15 text-red-400 ring-1 ring-red-500/30 animate-pulse' : 'text-[var(--text-soft)] hover:text-[var(--text)] hover:bg-white/5'
          }`}>
          {convo ? <Square size={16} className="fill-current" /> : <Mic size={18} />}
        </button>
        <button onClick={() => send(input)} disabled={sending || !input.trim()} aria-label="Invia"
          className="w-9 h-9 rounded-full flex items-center justify-center shrink-0 bg-gradient-to-br from-violet-500 to-violet-600 text-white shadow-lg shadow-violet-500/30 transition-all hover:from-violet-400 hover:to-violet-500 disabled:opacity-40 disabled:shadow-none disabled:cursor-not-allowed">
          {sending ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
        </button>
      </div>
    </div>
  );

  return (
    <>
      {/* Pannello chat (slide-up) — solo telefono. Conversazione scrollabile + input ancorato. */}
      {open && (
        <div className="lg:hidden fixed inset-0 z-[44] flex flex-col justify-end">
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setOpen(false)} />
          <div className="relative flex flex-col h-[86vh] rounded-t-[28px] border-t border-white/10 bg-[var(--surface)]/95 backdrop-blur-2xl ring-1 ring-white/5 shadow-[0_-24px_80px_-24px_rgba(107,84,198,0.55)]">
            {/* Grab handle */}
            <div className="mx-auto mt-3 mb-1.5 h-1.5 w-10 rounded-full bg-white/15 shrink-0" />

            <div className="flex items-center justify-between px-6 pt-1.5 pb-3 shrink-0">
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

            {/* Conversazione scrollabile (occupa lo spazio, l'input non la copre più) */}
            <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto px-5 py-3 space-y-3.5">
              {messages.length === 0 && (
                <div className="text-sm text-[var(--text-soft)] py-8 text-center leading-relaxed">
                  Ciao! Scrivimi o parla 👇<br />
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

            {/* Input ancorato in fondo al pannello */}
            <div className="shrink-0 px-3 pt-2 border-t border-white/5" style={{ paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 10px)' }}>
              {bar}
            </div>
          </div>
        </div>
      )}

      {/* Barra flottante (chat chiusa) — solo telefono, sopra la bottom-nav. */}
      {!open && (
        <div className="lg:hidden fixed left-3 right-3 z-[45]" style={{ bottom: 'calc(env(safe-area-inset-bottom, 0px) + 72px)' }}>
          {bar}
        </div>
      )}
    </>
  );
}
