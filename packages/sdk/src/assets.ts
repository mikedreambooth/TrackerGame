import { audioId, relayAudio } from './audio-relay';
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

/** Play a sound file by absolute URL. Returns a stop function. */
export function playSound(url: string, opts: PlayOptions = {}): () => void {
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
      src.start();
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
