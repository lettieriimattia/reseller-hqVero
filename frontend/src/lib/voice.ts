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
export async function recordCommand(maxMs = 9000, silenceMs = 1100, noSpeechMs = 4000): Promise<{ base64: string; mime: string } | null> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const mime = pickMime();
  const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  const chunks: Blob[] = [];
  rec.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };

  let ac: AudioContext | null = null;
  let analyser: AnalyserNode | null = null;
  try {
    ac = new (window.AudioContext || (window as any).webkitAudioContext)();
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
