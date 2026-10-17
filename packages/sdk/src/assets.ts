import { audioId, relayAudio, whenAudioDone } from './audio-relay';
import { audioContext } from './sound';

/**
 * Images and sounds for a game, loaded up front (and cached offline by the
 * service worker like everything else in the build).
 *
 * URLs are relative to the game's page. Two easy ways to get one:
 *  - put the file in the game's `public/` folder and use 'sfx/pop.mp3'
 *  - or import it so Vite fingerprints it: `import popUrl from './pop.mp3'`
 */
export interface AssetManifest {
  images?: Record<string, string>;
  sounds?: Record<string, string>;
}

export interface PlayOptions {
  volume?: number;
  loop?: boolean;
  /** Playback speed / pitch, 1 = normal. */
  rate?: number;
  /** Start this many seconds into the sound (e.g. to resume music). */
  offset?: number;
}

export interface Assets {
  images: Record<string, HTMLImageElement>;
  /** Play a loaded sound. Returns a function that stops it (handy for loops). */
  play(name: string, opts?: PlayOptions): () => void;
}

// ---------- local playback (also used by the launcher on games' behalf) ----------

const buffers = new Map<string, Promise<AudioBuffer>>();

/** Fetch + decode a sound once; later calls reuse it. */
export function preloadSound(url: string): Promise<AudioBuffer> {
  let p = buffers.get(url);
  if (!p) {
    p = fetch(url)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.arrayBuffer();
      })
      .then((b) => audioContext().decodeAudioData(b));
    buffers.set(url, p);
    p.catch(() => buffers.delete(url));
  }
  return p;
}

/** Play a sound file by absolute URL. Returns a stop function. `onStart` fires the moment audio starts. */
export function playSound(url: string, opts: PlayOptions = {}, onStart?: () => void): () => void {
  let stopped = false;
  let src: AudioBufferSourceNode | null = null;
  preloadSound(url)
    .then((buf) => {
      if (stopped) return;
      const ac = audioContext();
      src = ac.createBufferSource();
      const gain = ac.createGain();
      src.buffer = buf;
      src.loop = opts.loop ?? false;
      src.playbackRate.value = opts.rate ?? 1;
      gain.gain.value = opts.volume ?? 1;
      src.connect(gain).connect(ac.destination);
      src.start(0, Math.max(0, opts.offset ?? 0));
      onStart?.();
    })
    .catch((e) => console.warn(`[assets] could not play ${url}`, e));
  return () => {
    stopped = true;
    try {
      src?.stop();
    } catch {
      /* already stopped */
    }
  };
}

// ---------- the game-facing loader ----------

export async function loadAssets(
  manifest: AssetManifest,
  onProgress?: (done: number, total: number) => void,
): Promise<Assets> {
  const images: Record<string, HTMLImageElement> = {};
  const sounds: Record<string, string> = {};
  const jobs: Promise<void>[] = [];
  let done = 0;
  const total = Object.keys(manifest.images ?? {}).length + Object.keys(manifest.sounds ?? {}).length;
  const tick = () => onProgress?.(++done, total);
  const abs = (u: string) => new URL(u, document.baseURI).href;

  for (const [name, src] of Object.entries(manifest.images ?? {})) {
    jobs.push(
      (async () => {
        const img = new Image();
        img.src = abs(src);
        await img.decode().catch(() => {
          throw new Error(`Could not load image "${name}" (${src})`);
        });
        images[name] = img;
        tick();
      })(),
    );
  }
  for (const [name, src] of Object.entries(manifest.sounds ?? {})) {
    const url = abs(src);
    sounds[name] = url;
    // Embedded: the launcher loads and plays it. Standalone: decode here.
    if (relayAudio({ op: 'preload', url })) {
      tick();
      continue;
    }
    jobs.push(
      preloadSound(url).then(
        () => tick(),
        () => {
          throw new Error(`Could not load sound "${name}" (${src})`);
        },
      ),
    );
  }
  await Promise.all(jobs);

  return {
    images,
    play(name, opts = {}) {
      const url = sounds[name];
      if (!url) {
        console.warn(`[assets] unknown sound "${name}"`);
        return () => {};
      }
      const id = audioId();
      if (relayAudio({ op: 'play', id, url, opts })) return () => relayAudio({ op: 'stop', id });
      return playSound(url, opts);
    },
  };
}

export interface MusicHandle {
  stop(): void;
  /** Resolves (with performance.now()) when the music actually starts playing. */
  started: Promise<number>;
}

/**
 * Play a music file with an accurate start time, for rhythm games:
 *
 *   const m = playMusic('music/song.mp3', { offset: 12.5 });
 *   const t0 = await m.started;          // song time = offset + (now - t0) / 1000
 *
 * Inside the launcher the launcher plays it (so it works on iOS) and reports
 * back when it has started.
 */
export function playMusic(url: string, opts: PlayOptions = {}): MusicHandle {
  const abs = new URL(url, document.baseURI).href;
  const id = audioId();
  if (relayAudio({ op: 'play', id, url: abs, opts })) {
    return {
      stop: () => relayAudio({ op: 'stop', id }),
      started: whenAudioDone(id, 30_000).then(() => performance.now()),
    };
  }
  let resolve!: (t: number) => void;
  const started = new Promise<number>((r) => (resolve = r));
  const stop = playSound(abs, opts, () => resolve(performance.now()));
  return { stop, started };
}
