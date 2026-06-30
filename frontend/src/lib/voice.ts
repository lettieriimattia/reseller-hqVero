// voice.ts — registrazione audio del browser + trascrizione Whisper (Groq) + wake-word Picovoice.
//
// Perché: Safari iOS NON ha speech-to-text nativo. Quindi registriamo l'audio col
// MediaRecorder e lo mandiamo a /api/assistant/transcribe (Whisper su Groq). La wake-word
// "Ehy HQ" è on-device con Picovoice Porcupine. Tutto degrada con grazia: se manca la
// access key o i modelli, la wake-word resta spenta e il mic manuale continua a funzionare.

export type ApiCall = <T = any>(path: string, opts?: RequestInit) => Promise<{ ok: boolean; data: T; status: number }>;

// Formato audio supportato dal browser (Whisper accetta webm/m4a/mp4/ogg/wav/mp3).
function pickMime(): string {
  const cands = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/aac', 'audio/ogg'];
  for (const c of cands) {
    try { if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(c)) return c; } catch { /* noop */ }
  }
  return '';
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onloadend = () => resolve(String(r.result || ''));
    r.onerror = () => reject(new Error('lettura audio fallita'));
    r.readAsDataURL(blob);
  });
}

export function isRecordingSupported(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== 'undefined';
}

// Registratore con start/stop manuale (mic "tieni premuto/tocca per parlare").
export class VoiceRecorder {
  private rec: MediaRecorder | null = null;
  private stream: MediaStream | null = null;
  private chunks: Blob[] = [];
  private mime = '';
  recording = false;

  async start(): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    this.mime = pickMime();
    this.rec = new MediaRecorder(this.stream, this.mime ? { mimeType: this.mime } : undefined);
    this.chunks = [];
    this.rec.ondataavailable = e => { if (e.data && e.data.size) this.chunks.push(e.data); };
    this.rec.start();
    this.recording = true;
  }

  async stop(): Promise<{ base64: string; mime: string } | null> {
    const rec = this.rec;
    this.recording = false;
    if (!rec) { this.cleanup(); return null; }
    return new Promise(resolve => {
      rec.onstop = async () => {
        const blob = this.chunks.length ? new Blob(this.chunks, { type: this.mime || 'audio/webm' }) : null;
        this.cleanup();
        if (!blob || !blob.size) { resolve(null); return; }
        try { resolve({ base64: await blobToBase64(blob), mime: blob.type }); } catch { resolve(null); }
      };
      try { rec.stop(); } catch { this.cleanup(); resolve(null); }
    });
  }

  cancel(): void { try { this.rec?.stop(); } catch { /* noop */ } this.cleanup(); this.recording = false; }

  private cleanup(): void {
    this.stream?.getTracks().forEach(t => t.stop());
    this.stream = null;
    this.rec = null;
    this.chunks = [];
  }
}

// Registra a mani libere: si ferma da sola dopo `silenceMs` di silenzio (a parlato avvenuto)
// o al massimo dopo `maxMs`. Usata dopo la wake-word "Ehy HQ".
export async function recordCommand(maxMs = 9000, silenceMs = 1100, noSpeechMs = 4000, onLevel?: (level: number) => void): Promise<{ base64: string; mime: string } | null> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const mime = pickMime();
  const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  const chunks: Blob[] = [];
  rec.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };

  let ac: AudioContext | null = null;
  let analyser: AnalyserNode | null = null;
  try {
    ac = new (window.AudioContext || (window as any).webkitAudioContext)();
    try { await ac.resume(); } catch { /* iOS suspended */ }
    const src = ac.createMediaStreamSource(stream);
    analyser = ac.createAnalyser();
    analyser.fftSize = 512;
    src.connect(analyser);
  } catch { /* senza analisi: ripieghiamo sul solo timeout maxMs */ }

  const buf = analyser ? new Uint8Array(analyser.fftSize) : null;

  return new Promise(resolve => {
    let stopped = false;
    let spokeOnce = false;
    let lastLoud = Date.now();
    const started = Date.now();

    const cleanup = () => {
      clearInterval(timer);
      try { ac?.close(); } catch { /* noop */ }
      stream.getTracks().forEach(t => t.stop());
    };
    rec.onstop = async () => {
      cleanup();
      // Nessuna voce rilevata: torna null così il chiamante NON sprona Whisper a vuoto.
      if (!spokeOnce) { resolve(null); return; }
      const blob = chunks.length ? new Blob(chunks, { type: mime || 'audio/webm' }) : null;
      if (!blob || !blob.size) { resolve(null); return; }
      try { resolve({ base64: await blobToBase64(blob), mime: blob.type }); } catch { resolve(null); }
    };
    const finish = () => { if (stopped) return; stopped = true; try { rec.stop(); } catch { cleanup(); resolve(null); } };

    const timer = setInterval(() => {
      const now = Date.now();
      if (analyser && buf) {
        analyser.getByteTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; sum += v * v; }
        const rms = Math.sqrt(sum / buf.length);
        if (onLevel) { try { onLevel(Math.min(1, rms * 6)); } catch { /* noop */ } } // livello per l'onda visiva
        if (rms > 0.045) { lastLoud = now; spokeOnce = true; }
        // Ha parlato e poi pausa → invia. Non ha mai parlato per 'noSpeechMs' → chiudi presto (null).
        if (spokeOnce && now - lastLoud > silenceMs) return finish();
        if (!spokeOnce && now - started > noSpeechMs) return finish();
      }
      if (now - started > maxMs) return finish();
    }, 100);

    rec.start();
  });
}

export async function transcribe(apiCall: ApiCall, audioBase64: string, mime: string): Promise<string> {
  const { ok, data } = await apiCall<{ text?: string; error?: string }>('/api/assistant/transcribe', {
    method: 'POST',
    body: JSON.stringify({ audioBase64, mime }),
  });
  if (!ok) throw new Error(data?.error || 'Trascrizione non riuscita');
  return (data?.text || '').trim();
}

// ---- Wake-word "Ehy HQ" (Picovoice Porcupine, on-device) ----
// Ritorna una funzione di stop. Va in errore (gestito dal chiamante) se manca access key/modelli.
export interface WakeWordHandle { stop: () => Promise<void>; pause: () => Promise<void>; resume: () => Promise<void>; }

// ---- Wake-word via VOSK (on-device, gratis, funziona anche su iOS) ----
// Riconoscimento continuo on-device: quando sente uno dei trigger ("ehy hq", "acca cu"...)
// chiama onWake. pause()/resume() liberano e riacquisiscono il mic (per la registrazione
// del comando con Whisper, evitando due stream insieme su iOS). stop() termina tutto.
export async function startVoskWakeWord(opts: {
  modelUrl: string;
  triggers: string[];
  onCommand: (text: string) => void; // testo del comando DOPO la wake-word → va in chat ed esegue
  onWake?: () => void;               // wake-word sentita ma comando non ancora detto (apri/feedback)
  onPartial?: (text: string) => void;
}): Promise<WakeWordHandle> {
  const { createModel } = await import('vosk-browser');
  const model: any = await createModel(opts.modelUrl);
  let recognizer: any = null; // creato col sample-rate REALE dell'AudioContext (Vosk ricampiona a 16k)

  const triggers = opts.triggers.map(t => t.toLowerCase().trim()).filter(Boolean);
  const norm = (s: string) => ' ' + (s || '').toLowerCase().replace(/[^a-zàèéìòù\s]/g, ' ').replace(/\s+/g, ' ').trim() + ' ';
  let armed = false, armedAt = 0, lastCmd = 0;
  let partialTimer: any = null, lastHandled = ''; // alcuni device non emettono il 'result' finale:
                                                  // processiamo anche un parziale rimasto stabile.

  // Comando dopo la wake-word: prende il testo che segue l'ultimo trigger nella frase.
  // Ritorna null se la frase NON contiene nessun trigger; '' se contiene il trigger ma nulla dopo.
  const commandAfter = (text: string): string | null => {
    const lower = norm(text);
    let pos = -1, tr = '';
    for (const t of triggers) { const i = lower.lastIndexOf(' ' + t + ' '); if (i > pos) { pos = i; tr = t; } }
    if (pos < 0) return null;
    return lower.slice(pos + tr.length + 2).trim();
  };

  // Vosk (modello IT) spesso NON trascrive "hq"/"acca cu". Quindi accettiamo come comando anche
  // una frase che inizia con un verbo d'azione (con o senza la wake-word davanti).
  const CMD_RE = /^(?:ok |ehi |ehy |hq |acca cu |hey hq )?(aggiung|inseri|metti|aggiorn|vend|valut|quant[oa]|cerc|trov|cancell|elimin|imposta|registr|segna)/;

  const handleFinal = (raw: string) => {
    const text = (raw || '').trim();
    if (!text) return;
    const after = commandAfter(text);
    if (after !== null) {                       // la frase contiene la wake-word
      if (Date.now() - lastCmd < 1500) return;  // anti-doppio
      if (after.length > 1) { lastCmd = Date.now(); armed = false; opts.onCommand(after); } // "ehy hq <comando>"
      else { armed = true; armedAt = Date.now(); opts.onWake && opts.onWake(); }            // solo wake-word: aspetto la frase dopo
      return;
    }
    if (armed && Date.now() - armedAt < 7000) { // frase successiva dopo la wake-word = comando
      armed = false; lastCmd = Date.now(); opts.onCommand(text);
      return;
    }
    // Fallback: la wake-word non è stata trascritta ma la frase è chiaramente un comando.
    if (CMD_RE.test(norm(text).trim() + ' ')) {
      if (Date.now() - lastCmd < 1500) return;
      lastCmd = Date.now(); armed = false; opts.onCommand(text.trim());
    }
  };

  const resultText = (m: any): string =>
    m?.result?.text || (Array.isArray(m?.result?.result) ? m.result.result.map((w: any) => w.word).join(' ') : '');

  let stream: MediaStream | null = null;
  let ac: AudioContext | null = null;
  let node: ScriptProcessorNode | null = null;
  let source: MediaStreamAudioSourceNode | null = null;
  // Auto-recupero: su iOS l'AudioContext/lo stream muoiono quando l'app va in background, si
  // blocca lo schermo o arriva un'interruzione audio. Senza ripristino, la wake-word si "stacca"
  // e va riattivata a mano. Questi flag + il watchdog la fanno ripartire da sola al rientro.
  let wantRunning = true;            // true = vogliamo essere in ascolto (false durante pause()/stop())
  let lastFrameAt = Date.now();      // ultimo frame audio ricevuto: se si ferma, l'audio è morto
  let restarting = false;
  let watchdog: any = null;

  const startAudio = async () => {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    // Se una traccia finisce (iOS la chiude in background) → ricostruisci tutto al rientro.
    stream.getAudioTracks().forEach(t => { t.onended = () => { if (wantRunning) restartAudio(); }; });
    ac = new (window.AudioContext || (window as any).webkitAudioContext)();
    try { await ac.resume(); } catch { /* iOS: l'AudioContext parte sospeso, va riattivato */ }
    if (!recognizer) {
      // Sample-rate = quello reale dell'audio (di solito 48000): il bug era crearlo a 16000.
      recognizer = new model.KaldiRecognizer(ac.sampleRate);
      try { recognizer.setWords(true); } catch { /* opzionale */ }
      recognizer.on('result', (m: any) => {
        const t = resultText(m);
        if (opts.onPartial) opts.onPartial(t);
        if (partialTimer) { clearTimeout(partialTimer); partialTimer = null; }
        lastHandled = t; handleFinal(t);
      });
      recognizer.on('partialresult', (m: any) => {
        const p = m?.result?.partial || '';
        if (opts.onPartial) opts.onPartial(p);
        if (partialTimer) clearTimeout(partialTimer);
        // se il parziale resta uguale per ~900ms (pausa) lo trattiamo come comando finale
        partialTimer = setTimeout(() => { if (p && p !== lastHandled) { lastHandled = p; handleFinal(p); } }, 900);
      });
    }
    node = ac.createScriptProcessor(4096, 1, 1);
    node.onaudioprocess = (e: AudioProcessingEvent) => {
      lastFrameAt = Date.now(); // segna che l'audio scorre (il watchdog lo usa per capire se è morto)
      try { recognizer.acceptWaveform(e.inputBuffer); } catch { /* frame skip */ }
    };
    source = ac.createMediaStreamSource(stream);
    source.connect(node);
    node.connect(ac.destination);
  };
  const stopAudio = () => {
    try { source?.disconnect(); } catch { /* noop */ }
    try { node?.disconnect(); } catch { /* noop */ }
    try { stream?.getTracks().forEach(t => t.stop()); } catch { /* noop */ }
    try { ac?.close(); } catch { /* noop */ }
    stream = null; ac = null; node = null; source = null;
  };

  // Ricostruisce stream + AudioContext senza toccare modello/recognizer (riusati). Idempotente.
  const restartAudio = async () => {
    if (!wantRunning || restarting) return;
    restarting = true;
    try { stopAudio(); } catch { /* noop */ }
    try { await startAudio(); } catch { /* il watchdog riproverà al giro dopo */ }
    lastFrameAt = Date.now();
    restarting = false;
  };

  // Rientro in primo piano: riattiva l'AudioContext sospeso e, se lo stream è morto, ricostruiscilo.
  // Così tornando nell'app la wake-word riparte DA SOLA, senza riconnettere a mano.
  const onVisible = () => {
    if (!wantRunning || document.visibilityState !== 'visible') return;
    if (ac && ac.state === 'suspended') ac.resume().catch(() => {});
    const dead = !stream || stream.getAudioTracks().every(t => t.readyState === 'ended');
    if (dead) restartAudio();
  };
  const teardown = () => {
    if (watchdog) { clearInterval(watchdog); watchdog = null; }
    document.removeEventListener('visibilitychange', onVisible);
    window.removeEventListener('focus', onVisible);
    window.removeEventListener('pageshow', onVisible);
  };

  await startAudio();

  document.addEventListener('visibilitychange', onVisible);
  window.addEventListener('focus', onVisible);
  window.addEventListener('pageshow', onVisible);
  // Watchdog (cuore dell'auto-recupero): ogni 2.5s, se siamo in ascolto e l'app è in primo piano
  // ma l'audio è sospeso/fermo/morto, riattiva o ricostruisce.
  watchdog = setInterval(() => {
    if (!wantRunning || document.visibilityState !== 'visible') return;
    // Sospeso → prova solo a riattivare e dai una chance fino al giro dopo (niente rebuild inutile).
    if (ac && ac.state === 'suspended') { ac.resume().catch(() => {}); return; }
    const stale = Date.now() - lastFrameAt > 4000; // running ma nessun frame = pipeline rotta
    const dead = !stream || stream.getAudioTracks().every(t => t.readyState === 'ended');
    if (stale || dead) restartAudio();
  }, 2500);

  return {
    pause: async () => { wantRunning = false; stopAudio(); },                 // libera il mic per il comando
    resume: async () => { wantRunning = true; try { await startAudio(); } catch { /* il watchdog riproverà */ } },
    stop: async () => { wantRunning = false; teardown(); stopAudio(); try { recognizer.remove(); } catch { /* noop */ } try { model.terminate(); } catch { /* noop */ } },
  };
}

export async function startWakeWord(opts: {
  accessKey: string;
  onWake: () => void;
  keywordPath?: string;
  paramsPath?: string;
  label?: string;
  sensitivity?: number;
}): Promise<WakeWordHandle> {
  const { PorcupineWorker } = await import('@picovoice/porcupine-web');
  const { WebVoiceProcessor } = await import('@picovoice/web-voice-processor');

  const worker = await PorcupineWorker.create(
    opts.accessKey,
    [{ publicPath: opts.keywordPath || '/picovoice/Ehy_HQ.ppn', label: opts.label || 'Ehy HQ', sensitivity: opts.sensitivity ?? 0.6 }],
    (detection: { label: string; index: number }) => { if (detection && detection.index >= 0) opts.onWake(); },
    { publicPath: opts.paramsPath || '/picovoice/porcupine_params.pv' },
  );

  await WebVoiceProcessor.subscribe(worker);

  return {
    pause: async () => { try { await WebVoiceProcessor.unsubscribe(worker); } catch { /* noop */ } },
    resume: async () => { try { await WebVoiceProcessor.subscribe(worker); } catch { /* noop */ } },
    stop: async () => {
      try { await WebVoiceProcessor.unsubscribe(worker); } catch { /* noop */ }
      try { worker.release(); } catch { /* noop */ }
      try { worker.terminate(); } catch { /* noop */ }
    },
  };
}
