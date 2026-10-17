/**
 * Natural-sounding voice (Piper) for say(). Runs in a worker; downloads the
 * voice once (~60 MB) and keeps it on the device. Until it's ready — or if it
 * fails — say() uses the browser's built-in voice instead.
 */
import { audioContext } from '../sound';

/** British female voice. Others: en_GB-cori-medium, en_GB-alan-medium, en_GB-northern_english_male-medium… */
export const DEFAULT_NATURAL_VOICE = 'en_GB-jenny_dioco-medium';

export interface VoiceStatus {
  state: 'off' | 'loading' | 'ready' | 'failed';
  voiceId: string;
  /** 0..1 while downloading. */
  progress: number;
  message?: string;
}

type Listener = (s: VoiceStatus) => void;

class NaturalVoice {
  status: VoiceStatus = { state: 'off', voiceId: '', progress: 0 };
  private worker: Worker | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (b: ArrayBuffer) => void; reject: (e: Error) => void }>();
  private cache = new Map<string, Promise<AudioBuffer>>();
  private listeners: Listener[] = [];
  private files = new Map<string, { loaded: number; total: number }>();
  private queued: string[] = [];

  start(voiceId = DEFAULT_NATURAL_VOICE): void {
    if (this.worker || typeof Worker === 'undefined') return;
    this.set({ state: 'loading', voiceId, progress: 0, message: 'Starting voice…' });
    try {
      this.worker = new Worker(new URL('./piper-worker.ts', import.meta.url), { type: 'module' });
    } catch (e) {
      this.set({ ...this.status, state: 'failed', message: `Voice worker unavailable: ${(e as Error).message}` });
      return;
    }
    this.worker.onerror = (e) => this.fail(`Voice worker error: ${e.message || 'could not load'}`);
    this.worker.onmessage = (e: MessageEvent) => {
      const m = e.data;
      if (m.type === 'progress') {
        this.files.set(m.url, { loaded: m.loaded, total: m.total });
        let loaded = 0;
        let total = 0;
        for (const f of this.files.values()) {
          loaded += f.loaded;
          total += f.total;
        }
        const progress = total ? loaded / total : 0;
        this.set({ ...this.status, progress, message: `Downloading voice ${Math.round(progress * 100)}%` });
      } else if (m.type === 'ready') {
        this.set({ ...this.status, state: 'ready', progress: 1, message: 'Voice ready' });
        const lines = this.queued;
        this.queued = [];
        this.prepare(lines);
      } else if (m.type === 'audio') {
        this.pending.get(m.id)?.resolve(m.wav);
        this.pending.delete(m.id);
      } else if (m.type === 'error') {
        if (m.id !== undefined) {
          this.pending.get(m.id)?.reject(new Error(m.message));
          this.pending.delete(m.id);
        } else this.fail(`Voice failed to load: ${m.message}`);
      }
    };
    this.worker.postMessage({ type: 'init', voiceId });
  }

  get ready(): boolean {
    return this.status.state === 'ready';
  }

  onStatus(cb: Listener): void {
    this.listeners.push(cb);
    cb(this.status);
  }

  /** Synthesize (cached by text) and decode, ready to play. */
  synth(text: string): Promise<AudioBuffer> {
    const key = text.trim();
    let p = this.cache.get(key);
    if (!p) {
      p = new Promise<ArrayBuffer>((resolve, reject) => {
        if (!this.worker || !this.ready) return reject(new Error('voice not ready'));
        const id = this.nextId++;
        this.pending.set(id, { resolve, reject });
        this.worker.postMessage({ type: 'speak', id, text: key });
      }).then((wav) => audioContext().decodeAudioData(wav));
      this.cache.set(key, p);
      p.catch(() => this.cache.delete(key));
      // Keep the cache from growing forever (dynamic lines like scores).
      if (this.cache.size > 200) this.cache.delete(this.cache.keys().next().value!);
    }
    return p;
  }

  /** Synthesize lines in the background so they play instantly later. */
  prepare(lines: string[]): void {
    if (!this.ready) {
      this.queued.push(...lines);
      return;
    }
    // One at a time, so live lines aren't stuck behind a long batch.
    lines.reduce<Promise<unknown>>((prev, line) => prev.then(() => this.synth(line).catch(() => {})), Promise.resolve());
  }

  private fail(message: string): void {
    this.worker?.terminate();
    this.worker = null;
    for (const p of this.pending.values()) p.reject(new Error(message));
    this.pending.clear();
    this.set({ ...this.status, state: 'failed', message });
    console.warn('[voice]', message);
  }

  private set(s: VoiceStatus): void {
    this.status = s;
    for (const cb of this.listeners) cb(s);
  }
}

export const naturalVoice = new NaturalVoice();

/**
 * Start downloading/loading the natural voice in the background. The launcher
 * calls this at startup (skip with ?voice=browser, pick another with ?voice=<id>).
 */
export function startNaturalVoice(voiceId?: string): void {
  naturalVoice.start(voiceId);
}
