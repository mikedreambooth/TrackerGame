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

export async function loadAssets(
  manifest: AssetManifest,
  onProgress?: (done: number, total: number) => void,
): Promise<Assets> {
  const images: Record<string, HTMLImageElement> = {};
  const buffers: Record<string, AudioBuffer> = {};
  const jobs: Promise<void>[] = [];
  let done = 0;
  const total = Object.keys(manifest.images ?? {}).length + Object.keys(manifest.sounds ?? {}).length;
  const tick = () => onProgress?.(++done, total);
  const url = (u: string) => new URL(u, document.baseURI).href;

  for (const [name, src] of Object.entries(manifest.images ?? {})) {
    jobs.push(
      (async () => {
        const img = new Image();
        img.src = url(src);
        await img.decode().catch(() => {
          throw new Error(`Could not load image "${name}" (${src})`);
        });
        images[name] = img;
        tick();
      })(),
    );
  }
  for (const [name, src] of Object.entries(manifest.sounds ?? {})) {
    jobs.push(
      (async () => {
        const res = await fetch(url(src));
        if (!res.ok) throw new Error(`Could not load sound "${name}" (${src}): HTTP ${res.status}`);
        buffers[name] = await audioContext().decodeAudioData(await res.arrayBuffer());
        tick();
      })(),
    );
  }
  await Promise.all(jobs);

  return {
    images,
    play(name, opts = {}) {
      const buf = buffers[name];
      if (!buf) {
        console.warn(`[assets] unknown sound "${name}"`);
        return () => {};
      }
      try {
        const ac = audioContext();
        const src = ac.createBufferSource();
        const gain = ac.createGain();
        src.buffer = buf;
        src.loop = opts.loop ?? false;
        src.playbackRate.value = opts.rate ?? 1;
        gain.gain.value = opts.volume ?? 1;
        src.connect(gain).connect(ac.destination);
        src.start();
        return () => {
          try {
            src.stop();
          } catch {
            /* already stopped */
          }
        };
      } catch {
        return () => {};
      }
    },
  };
}
