// AssistantChat — chatbox "HQ" (BETA · solo admin · solo telefono).
// Barra di scrittura luminosa in basso: l'utente scrive in linguaggio naturale e
// l'assistente (Groq + tool-calling) cerca nel catalogo, aggiunge prodotti, valuta prezzi.
// Microfono = dettatura vocale (Web Speech API). La wake-word "Ehy HQ" arriva in fase 3 (Picovoice).

import { useState, useRef, useEffect, useCallback } from 'react';
import { Sparkles, Send, Mic, X, Loader2, Square, Radio, Plus } from 'lucide-react';
import { recordCommand, transcribe, startVoskWakeWord, isRecordingSupported, VoiceRecorder, type WakeWordHandle } from '../lib/voice';

type ApiCall = <T = any>(path: string, opts?: RequestInit) => Promise<{ ok: boolean; data: T; status: number }>;
type Msg = { role: 'user' | 'assistant'; content: string };

interface Props {
  apiCall: ApiCall;
  showToast: (msg: string, type?: 'ok' | 'err' | 'warn') => void;
  onAction: () => void; // refresh magazzino dopo un'azione (es. prodotto aggiunto)
  lang?: string;        // lingua app → sceglie il modello Vosk (it/en) per la wake-word
  hideBar?: boolean;    // nascondi la barra flottante (es. quando è aperta la barra selezione multipla)
  onPlus?: () => void;  // tap sul "+" nella barra → apre l'aggiunta prodotto
}

type VoiceState = 'idle' | 'recording' | 'transcribing';

// Onda audio dal vivo: barre che salgono col volume della voce (capisci che ti sta ascoltando).
function Waveform({ level }: { level: number }) {
  const factors = [0.45, 0.75, 1, 0.85, 0.55, 0.9, 0.6];
  return (
    <div className="flex items-center gap-[3px] h-5">
      {factors.map((f, i) => (
        <span key={i} className="w-[3px] rounded-full bg-violet-400 transition-[height] duration-100 ease-out"
          style={{ height: `${Math.max(3, Math.min(20, f * level * 26 + 3))}px` }} />
      ))}
    </div>
  );
}

export default function AssistantChat({ apiCall, showToast, onAction, lang = 'it', hideBar = false, onPlus }: Props) {
  const [open, setOpen] = useState(false);
  // La conversazione resta finché non chiudi l'app (sessionStorage = si svuota alla chiusura).
  const [messages, setMessages] = useState<Msg[]>(() => {
    try { const s = sessionStorage.getItem('hq_chat'); return s ? JSON.parse(s) : []; } catch { return []; }
  });
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [voiceState, setVoiceState] = useState<VoiceState>('idle');
  const [wakeOn, setWakeOn] = useState(false);      // wake-word Vosk effettivamente in ascolto
  // Toggle "Ehy HQ": l'utente lo accende (così il mic non parte a sorpresa al caricamento).
  const [wakeEnabled, setWakeEnabled] = useState(() => {
    try { return localStorage.getItem('hq_wake') === '1'; } catch { return false; }
  });
  const [wakeLoading, setWakeLoading] = useState(false);
  // Il browser richiede UN gesto utente per accendere il mic: dopo il primo tocco nell'app
  // la wake-word parte da sola (se attivata). Così "apri → tap → di' ehy hq".
  const [gestureReady, setGestureReady] = useState(false);
  const [convo, setConvo] = useState(false); // modalità conversazione continua (mani libere)
  const [micLevel, setMicLevel] = useState(0); // livello audio dal vivo (onda)
  // Push-to-talk stile WhatsApp: tieni premuto = registra · su = blocca · sinistra = annulla.
  const [pttActive, setPttActive] = useState(false);
  const [pttLocked, setPttLocked] = useState(false);
  const [pttCancel, setPttCancel] = useState(false);
  const [pttSecs, setPttSecs] = useState(0);
  const recRef = useRef<VoiceRecorder | null>(null);
  const pttStartRef = useRef({ x: 0, y: 0 });
  const pttLockedRef = useRef(false);
  const pttCancelRef = useRef(false);
  const pttTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const wakeRef = useRef<WakeWordHandle | null>(null);
  const voiceBusyRef = useRef(false);
  const convoRef = useRef(false);
  // Altezza tastiera (iOS/Android) via VisualViewport: alza la barra/input sopra la tastiera
  // così vedi sempre quello che scrivi.
  const [kbInset, setKbInset] = useState(0);
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const onResize = () => {
      const inset = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      setKbInset(inset > 90 ? inset : 0); // ignora piccoli scostamenti (barre del browser)
    };
    vv.addEventListener('resize', onResize);
    vv.addEventListener('scroll', onResize);
    onResize();
    return () => { vv.removeEventListener('resize', onResize); vv.removeEventListener('scroll', onResize); };
  }, []);
  const scrollRef = useRef<HTMLDivElement>(null);
  const recSupported = isRecordingSupported();

  useEffect(() => {
    if (open && scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, open, sending, voiceState]);

  // Persisti la conversazione per la sessione (ultimi 60 messaggi).
  useEffect(() => {
    try { sessionStorage.setItem('hq_chat', JSON.stringify(messages.slice(-60))); } catch { /* storage pieno */ }
  }, [messages]);

  // fromVoice = comando detto con "hq ..." da fuori: esegue in BACKGROUND, mostra l'esito a
  // toast e NON apre il pannello chat.
  const send = useCallback(async (text: string, fromVoice = false) => {
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
    if (fromVoice) showToast(reply, 'ok'); // a chat chiusa: l'esito appare come notifica
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
        clip = await recordCommand(9000, 1100, 4000, setMicLevel); // si ferma da sola alla pausa
      } catch {
        showToast('Permesso microfono negato', 'err');
        stopConvo();
        return;
      }
      setMicLevel(0);
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

  // ===== Push-to-talk (mic stile WhatsApp) =====
  const finishPtt = useCallback(async (action: 'send' | 'cancel') => {
    const rec = recRef.current;
    recRef.current = null;
    if (pttTimerRef.current) { clearInterval(pttTimerRef.current); pttTimerRef.current = null; }
    setPttActive(false); setPttLocked(false); setPttCancel(false);
    pttLockedRef.current = false; pttCancelRef.current = false;
    if (!rec) return;
    if (action === 'cancel') { rec.cancel(); return; }
    const clip = await rec.stop();
    if (!clip) return;                       // niente audio
    setVoiceState('transcribing');
    let text = '';
    try { text = await transcribe(apiCall, clip.base64, clip.mime); } catch { /* errore trascrizione */ }
    setVoiceState('idle');
    const t = (text || '').trim();
    if (t) sendRef.current(t, true);         // esegue il comando in background (toast)
  }, [apiCall]);

  const startPtt = useCallback(async (e: React.PointerEvent) => {
    if (pttActive || sending) return;
    e.preventDefault();
    if (!recSupported) { showToast('Microfono non disponibile su questo browser', 'warn'); return; }
    try { (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId); } catch { /* noop */ }
    pttStartRef.current = { x: e.clientX, y: e.clientY };
    setPttCancel(false); setPttLocked(false);
    pttCancelRef.current = false; pttLockedRef.current = false;
    const rec = new VoiceRecorder();
    try { await rec.start(); } catch { showToast('Permesso microfono negato', 'err'); return; }
    recRef.current = rec;
    setPttActive(true); setPttSecs(0);
    pttTimerRef.current = setInterval(() => setPttSecs(s => s + 1), 1000);
  }, [pttActive, sending, recSupported, showToast]);

  const movePtt = useCallback((e: React.PointerEvent) => {
    if (!recRef.current || pttLockedRef.current) return;
    const dy = pttStartRef.current.y - e.clientY; // su = positivo
    const dx = pttStartRef.current.x - e.clientX; // sinistra = positivo
    if (dy > 70) { pttLockedRef.current = true; setPttLocked(true); pttCancelRef.current = false; setPttCancel(false); return; }
    const c = dx > 90;
    if (c !== pttCancelRef.current) { pttCancelRef.current = c; setPttCancel(c); }
  }, []);

  const endPtt = useCallback((e: React.PointerEvent) => {
    if (!recRef.current) return;
    try { (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId); } catch { /* noop */ }
    if (pttLockedRef.current) return;        // bloccato: resta a registrare, si invia col tasto
    finishPtt(pttCancelRef.current ? 'cancel' : 'send');
  }, [finishPtt]);

  // Wake-word "Ehy HQ" via VOSK (on-device): quando l'utente l'ha ATTIVATA, ascolta in
  // continuo e a riconoscimento apre la chat, registra il comando (pausa = fine), trascrive
  // con Whisper e invia. Modello scelto per lingua (it: "acca cu"…, en: "hey hq"…).
  // true quando l'utente ha ATTIVATO il vocale ora (toggle): in quel caso il permesso mic è
  // appena stato concesso → si parte subito. Sull'apertura "fredda" invece NON si chiede.
  const userArmedRef = useRef(false);
  useEffect(() => {
    if (!wakeEnabled || !recSupported || !gestureReady) return;
    let cancelled = false;

    const begin = () => {
      if (cancelled) return;
      setWakeLoading(true);
      const isEn = (lang || 'it').toLowerCase().startsWith('en');
      const modelUrl = isEn ? '/vosk/model-en.tar.gz' : '/vosk/model-it.tar.gz';
      const triggers = isEn
        ? ['hey hq', 'ehy hq', 'hey h q', 'hq', 'h q', 'headquarters']
        : ['acca cu', 'acca qu', 'acca cchu', 'ehy hq', 'hey hq', 'hq', 'h q', 'headquarters'];

      // Comando riconosciuto da Vosk (testo dopo "ehy hq") → ESEGUE in BACKGROUND, senza aprire
      // la chat. L'esito appare a toast. (Es. dal magazzino: "hq inseriscimi una Jordan 4".)
      const onCommand = (text: string) => {
        const t = (text || '').trim();
        if (!t || convoRef.current) return;
        sendRef.current(t, true);
      };

      startVoskWakeWord({ modelUrl, triggers, onCommand, onWake: () => showToast('🎙️ Dimmi pure…', 'ok') })
        .then(h => { if (cancelled) { h.stop(); return; } wakeRef.current = h; setWakeOn(true); setWakeLoading(false);
          // Ricorda che il mic è stato concesso: su iOS (niente Permissions API) serve per ri-armare
          // da soli alle aperture successive, senza riconnettere a mano.
          try { localStorage.setItem('hq_mic_granted', '1'); } catch { /* noop */ } })
        .catch((e: any) => {
          setWakeLoading(false); setWakeOn(false);
          const msg = 'Voce non avviata: ' + (e?.message || 'errore modello/mic');
          showToast(msg, 'err');
          setMessages(m => [...m, { role: 'assistant', content: '⚠️ ' + msg }]); // visibile e persistente
        });
    };

    if (userArmedRef.current) {
      // L'utente l'ha appena attivato → mic già concesso, parto subito.
      userArmedRef.current = false;
      begin();
    } else {
      // Apertura dell'app: NON chiedere il microfono. Parto in automatico SOLO se il permesso è
      // già concesso (persistito). Se è da chiedere o non interrogabile (es. iOS), resto in
      // attesa che l'utente tocchi il mic → niente prompt ad ogni apertura.
      (async () => {
        try {
          const st: any = await (navigator as any).permissions?.query?.({ name: 'microphone' });
          if (st && st.state === 'granted') { begin(); return; }
          if (st && st.state === 'denied') return; // negato: non insistere
        } catch { /* Permissions API non supportata (iOS) */ }
        // iOS / niente Permissions API: se il mic è GIÀ stato concesso in passato, ri-arma dopo il
        // primo gesto. getUserMedia non ri-prompta se il permesso è persistito → niente tap manuale,
        // niente prompt a ogni apertura per chi non l'ha mai concesso.
        try { if (localStorage.getItem('hq_mic_granted') === '1') begin(); } catch { /* noop */ }
      })();
    }

    return () => {
      cancelled = true;
      setWakeOn(false);
      setWakeLoading(false);
      const h = wakeRef.current;
      wakeRef.current = null;
      h?.stop();
    };
  }, [wakeEnabled, recSupported, gestureReady, apiCall, lang, showToast]);

  // Persisti la preferenza wake-word.
  useEffect(() => { try { localStorage.setItem('hq_wake', wakeEnabled ? '1' : '0'); } catch { /* noop */ } }, [wakeEnabled]);

  // Attivazione/disattivazione da fuori (toggle nelle Impostazioni) via evento.
  useEffect(() => {
    const handler = (e: Event) => { const on = !!(e as CustomEvent).detail; if (on) userArmedRef.current = true; setWakeEnabled(on); };
    window.addEventListener('hq-wake', handler as EventListener);
    return () => window.removeEventListener('hq-wake', handler as EventListener);
  }, []);

  // Primo gesto utente nell'app → sblocca il mic per la wake-word.
  useEffect(() => {
    if (gestureReady) return;
    const arm = () => setGestureReady(true);
    window.addEventListener('pointerdown', arm, { once: true });
    return () => window.removeEventListener('pointerdown', arm);
  }, [gestureReady]);

  // Barra di scrittura/voce (riusata: ancorata nel pannello quando aperto, flottante quando chiuso).
  const bar = (
    <div className="relative rounded-full p-px bg-gradient-to-r from-violet-500/90 via-fuchsia-500/90 to-violet-500/90 shadow-[0_8px_44px_-8px_rgba(107,84,198,0.7)]">
      {/* Overlay registrazione (push-to-talk) sopra la barra. */}
      {pttActive && (
        <div className="absolute left-0 right-0 bottom-full mb-3 flex justify-center px-2">
          <div className={`flex items-center gap-3 px-4 py-2.5 rounded-2xl border backdrop-blur-xl shadow-xl ${pttCancel ? 'bg-red-500/20 border-red-400/40' : 'bg-[var(--surface)]/95 border-white/10'}`}>
            {pttCancel ? (
              <span className="text-sm font-bold text-red-300 flex items-center gap-2"><X size={16} /> Rilascia per annullare</span>
            ) : (
              <>
                <span className="w-2.5 h-2.5 rounded-full bg-red-400 animate-pulse shrink-0" />
                <span className="text-sm font-semibold text-[var(--text)] tabular-nums">{Math.floor(pttSecs / 60)}:{(pttSecs % 60).toString().padStart(2, '0')}</span>
                {pttLocked ? (
                  <>
                    <span className="text-xs text-[var(--text-soft)]">in registrazione…</span>
                    <button onClick={() => finishPtt('cancel')} className="ml-1 w-8 h-8 rounded-full flex items-center justify-center bg-white/5 text-[var(--text-soft)] hover:text-red-400 transition-colors"><X size={16} /></button>
                    <button onClick={() => finishPtt('send')} className="w-8 h-8 rounded-full flex items-center justify-center bg-gradient-to-br from-violet-500 to-violet-600 text-white"><Send size={15} /></button>
                  </>
                ) : (
                  <span className="text-xs text-[var(--text-soft)]">⬆︎ blocca · ⬅︎ annulla · rilascia = invia</span>
                )}
              </>
            )}
          </div>
        </div>
      )}
      <div className="flex items-center gap-2 rounded-full bg-[var(--surface)]/90 backdrop-blur-xl border border-white/5 pl-1.5 pr-1.5 py-2">
        {/* "+" grande = aggiungi un prodotto al volo. Quando ascolta/parla, un puntino pulsa sopra. */}
        <button onClick={() => { onPlus?.(); }} aria-label="Aggiungi prodotto"
          className="relative w-10 h-10 rounded-full flex items-center justify-center shrink-0 bg-gradient-to-br from-teal-500 to-emerald-600 text-white shadow-md shadow-teal-500/30 hover:from-teal-400 hover:to-emerald-500 transition-all active:scale-90">
          <Plus size={22} />
          {(convo || wakeOn) && (
            <span className={`absolute -top-0.5 -right-0.5 w-2.5 h-2.5 rounded-full ring-2 ring-[var(--surface)] animate-pulse ${convo ? 'bg-red-400' : 'bg-teal-200'}`} />
          )}
        </button>
        <input
          value={input}
          onChange={e => setInput(e.target.value)}
          onFocus={() => setOpen(true)}
          onKeyDown={e => { if (e.key === 'Enter') send(input); }}
          placeholder={
            convo ? (voiceState === 'transcribing' ? 'Trascrivo…' : 'Parla pure… faccio una pausa e invio')
            : sending ? 'Eseguo…'
            : wakeOn ? 'Chiedi a HQVault…  o di’ "Ehy HQ"'
            : 'Chiedi a HQVault...'}
          disabled={convo}
          style={{ WebkitAppearance: 'none', appearance: 'none' }}
          className="flex-1 bg-transparent border-0 outline-none focus:outline-none focus:ring-0 shadow-none text-sm text-[var(--text)] placeholder:text-[var(--text-faint)] min-w-0 disabled:opacity-70" />
        <button
          onPointerDown={startPtt} onPointerMove={movePtt} onPointerUp={endPtt}
          onPointerCancel={() => finishPtt('cancel')} onContextMenu={e => e.preventDefault()}
          aria-label="Tieni premuto per parlare"
          style={{ touchAction: 'none' }}
          className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 transition-all ${
            pttActive ? (pttCancel ? 'bg-red-500/25 text-red-300 scale-110' : 'bg-red-500/15 text-red-400 ring-1 ring-red-500/30 scale-110') : 'text-[var(--text-soft)] hover:text-[var(--text)] hover:bg-white/5'
          }`}>
          <Mic size={18} />
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
        <div className="fixed inset-0 z-[44] flex flex-col justify-end lg:inset-auto lg:bottom-6 lg:right-6 lg:left-auto lg:top-auto">
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm lg:hidden" onClick={() => setOpen(false)} />
          <div className="relative flex flex-col h-[86vh] rounded-t-[28px] border-t border-white/10 bg-[var(--surface)]/95 backdrop-blur-2xl ring-1 ring-white/5 shadow-[0_-24px_80px_-24px_rgba(107,84,198,0.55)] lg:h-[720px] lg:max-h-[88vh] lg:w-[480px] lg:rounded-[24px] lg:border lg:border-white/10">
            {/* Grab handle */}
            <div className="mx-auto mt-3 mb-1.5 h-1.5 w-10 rounded-full bg-white/15 shrink-0" />

            <div className="flex items-center justify-between px-6 pt-1.5 pb-3 shrink-0">
              <div className="flex items-center gap-2.5">
                <span className="w-8 h-8 rounded-full bg-gradient-to-br from-violet-500 to-fuchsia-500 flex items-center justify-center shadow-lg shadow-violet-500/30">
                  <Sparkles size={16} className="text-white" />
                </span>
                <div className="flex flex-col leading-none gap-1">
                  <span className="font-bold tracking-tight text-[var(--text)]">HQ<span className="text-gold">Vault</span></span>
                  <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-violet-400/80">
                    {wakeOn ? 'in ascolto di Ehy HQ' : 'Assistente · beta'}
                  </span>
                </div>
              </div>
              <div className="flex items-center gap-1">
                {/* Toggle wake-word "Ehy HQ" (Vosk on-device). L'utente la accende: niente mic a sorpresa. */}
                <button onClick={() => setWakeEnabled(v => { if (!v) userArmedRef.current = true; return !v; })} aria-label={wakeEnabled ? 'Disattiva Ehy HQ' : 'Attiva Ehy HQ'}
                  title='Ascolto "Ehy HQ"'
                  className={`flex items-center gap-1.5 px-2.5 h-8 rounded-full text-[11px] font-bold transition-colors ${
                    wakeOn ? 'bg-violet-500/15 text-violet-300 ring-1 ring-violet-500/30'
                    : wakeEnabled ? 'bg-white/5 text-[var(--text-soft)]'
                    : 'text-[var(--text-faint)] hover:text-[var(--text)] hover:bg-white/5'
                  }`}>
                  {wakeLoading ? <Loader2 size={14} className="animate-spin" /> : <Radio size={14} className={wakeOn ? 'animate-pulse' : ''} />}
                  Ehy HQ
                </button>
                <button onClick={() => setOpen(false)} aria-label="Chiudi"
                  className="text-[var(--text-faint)] hover:text-[var(--text)] p-1.5 rounded-full hover:bg-white/5 transition-colors">
                  <X size={20} />
                </button>
              </div>
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
              {/* Sto ascoltando / trascrivo — segno di vita con onda audio dal vivo */}
              {(voiceState === 'recording' || voiceState === 'transcribing') && (
                <div className="flex justify-end">
                  <div className="flex items-center gap-2.5 px-4 py-2.5 rounded-2xl rounded-br-md bg-violet-500/15 border border-violet-500/30">
                    {voiceState === 'recording'
                      ? <><Waveform level={micLevel} /><span className="text-xs text-violet-200 font-medium">in ascolto…</span></>
                      : <><Loader2 size={15} className="animate-spin text-violet-300" /><span className="text-xs text-violet-200 font-medium">trascrivo…</span></>}
                  </div>
                </div>
              )}
            </div>

            {/* Input ancorato in fondo al pannello — quando la tastiera è aperta lo alziamo sopra di essa. */}
            <div className="shrink-0 px-3 pt-2 border-t border-white/5" style={{ paddingBottom: kbInset > 0 ? kbInset + 10 : 'calc(env(safe-area-inset-bottom, 0px) + 10px)' }}>
              {bar}
            </div>
          </div>
        </div>
      )}

      {/* Barra flottante (chat chiusa) — solo telefono, sopra la bottom-nav.
          Nascosta quando è attiva la selezione multipla (barra bulk), per non sovrapporsi. */}
      {!open && !hideBar && (
        <div className="lg:hidden fixed left-3 right-3 z-[45]" style={{ bottom: kbInset > 0 ? kbInset + 10 : 'calc(var(--bottom-nav-h, 84px) + 14px)' }}>
          {bar}
        </div>
      )}

      {/* DESKTOP: barra chatbox in basso CENTRATA (stile Gemini/ChatGPT), nell'area contenuto. */}
      {!open && (
        <div className="hidden lg:block fixed bottom-6 left-60 right-0 z-[45] px-6 pointer-events-none">
          <div className="max-w-3xl mx-auto pointer-events-auto">{bar}</div>
        </div>
      )}
    </>
  );
}
