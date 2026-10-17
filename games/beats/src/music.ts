/**
 * The song's clock. Notes are timed against `time()`, so it must be smooth and
 * honest: it freezes while YouTube is buffering or showing an ad, so notes wait
 * for the music.
 */
import { playMusic, type MusicHandle } from '@trackergame/sdk';

export type MusicState = 'loading' | 'ready' | 'playing' | 'paused' | 'waiting' | 'blocked' | 'ended' | 'error';

export interface Music {
  readonly state: MusicState;
  readonly duration: number;
  readonly error?: string;
  load(): Promise<void>;
  /** Start (or resume) playing from song time `from` (s). */
  play(from: number): void;
  pause(): void;
  /** Current song time in seconds. */
  time(): number;
  destroy(): void;
}

// ---------- audio files (played by the launcher, synced via its start report) ----------

export class FileMusic implements Music {
  state: MusicState = 'loading';
  duration = 0;
  error?: string;
  private handle: MusicHandle | null = null;
  private startedAt: number | null = null;
  private from = 0;
  private pausedAt = 0;

  constructor(private url: string) {}

  async load(): Promise<void> {
    try {
      const res = await fetch(this.url, { method: 'HEAD' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      // Duration is filled in by the caller from beat analysis when available.
      this.state = 'ready';
    } catch (e) {
      this.state = 'error';
      this.error = `Couldn't load the music (${(e as Error).message})`;
    }
  }

  play(from: number): void {
    this.handle?.stop();
    this.from = from;
    this.startedAt = null;
    this.state = 'waiting';
    const h = playMusic(this.url, { offset: from });
    this.handle = h;
    void h.started.then((t) => {
      if (this.handle !== h) return;
      this.startedAt = t;
      this.state = 'playing';
    });
  }

  pause(): void {
    this.pausedAt = this.time();
    this.handle?.stop();
    this.handle = null;
    this.startedAt = null;
    this.state = 'paused';
  }

  time(): number {
    if (this.state === 'paused') return this.pausedAt;
    if (this.startedAt === null) return this.from;
    const t = this.from + (performance.now() - this.startedAt) / 1000;
    if (this.duration && t >= this.duration) this.state = 'ended';
    return t;
  }

  destroy(): void {
    this.handle?.stop();
    this.handle = null;
  }
}

// ---------- YouTube (official IFrame player) ----------

interface YTPlayer {
  playVideo(): void;
  pauseVideo(): void;
  seekTo(s: number, allowSeekAhead: boolean): void;
  getCurrentTime(): number;
  getDuration(): number;
  getPlayerState(): number;
  getVideoData?(): { title?: string };
  destroy(): void;
}
interface YTNamespace {
  Player: new (el: HTMLElement, opts: unknown) => YTPlayer;
}

let apiReady: Promise<YTNamespace> | null = null;
function loadYouTubeApi(): Promise<YTNamespace> {
  apiReady ??= new Promise((resolve, reject) => {
    const w = window as unknown as { YT?: YTNamespace & { loaded?: number }; onYouTubeIframeAPIReady?: () => void };
    if (w.YT?.Player) return resolve(w.YT);
    w.onYouTubeIframeAPIReady = () => resolve(w.YT!);
    const s = document.createElement('script');
    s.src = 'https://www.youtube.com/iframe_api';
    s.onerror = () => reject(new Error('YouTube is unreachable (offline?)'));
    document.head.append(s);
  });
  return apiReady;
}

const YT_ERRORS: Record<number, string> = {
  2: 'Invalid video id',
  5: "This video can't play in an embedded player",
  100: 'Video not found (removed or private)',
  101: "The video's owner doesn't allow it to be played in other apps",
  150: "The video's owner doesn't allow it to be played in other apps",
};

export class YouTubeMusic implements Music {
  state: MusicState = 'loading';
  duration = 0;
  error?: string;
  title?: string;
  private player: YTPlayer | null = null;
  private anchor = { yt: 0, at: 0 };
  private lastYt = -1;
  private out = 0;
  private wantPlaying = false;
  private playRequestedAt = 0;
  /** The player's methods only exist once YouTube says it's ready. */
  private ready = false;
  private pendingPlay: number | null = null;

  /** `host` is the element the video is shown in (behind the game canvas). */
  constructor(
    private videoId: string,
    private host: HTMLElement,
    /** Show YouTube's own controls (Song Editor). */
    private controls = false,
  ) {}

  async load(): Promise<void> {
    let YT: YTNamespace;
    try {
      YT = await loadYouTubeApi();
    } catch (e) {
      this.state = 'error';
      this.error = (e as Error).message;
      return;
    }
    const el = document.createElement('div');
    this.host.replaceChildren(el);
    await new Promise<void>((resolve) => {
      this.player = new YT.Player(el, {
        videoId: this.videoId,
        width: '100%',
        height: '100%',
        playerVars: { autoplay: 0, controls: this.controls ? 1 : 0, disablekb: 1, rel: 0, playsinline: 1, modestbranding: 1, iv_load_policy: 3 },
        events: {
          onReady: () => {
            this.ready = true;
            this.duration = this.player!.getDuration();
            this.title = this.player!.getVideoData?.().title;
            if (this.state === 'loading') this.state = 'ready';
            if (this.pendingPlay !== null) this.play(this.pendingPlay);
            resolve();
          },
          onError: (e: { data: number }) => {
            this.state = 'error';
            this.error = YT_ERRORS[e.data] ?? `YouTube error ${e.data}`;
            resolve();
          },
          onStateChange: (e: { data: number }) => {
            if (e.data === 0) this.state = 'ended';
          },
        },
      });
      setTimeout(() => {
        if (this.state === 'loading') {
          this.state = 'error';
          this.error = 'The video took too long to load';
          resolve();
        }
      }, 20_000);
    });
  }

  play(from: number): void {
    if (!this.player || !this.ready) {
      this.pendingPlay = from;
      return;
    }
    this.pendingPlay = null;
    this.wantPlaying = true;
    this.playRequestedAt = performance.now();
    if (Math.abs(this.player.getCurrentTime() - from) > 0.3) this.player.seekTo(from, true);
    this.player.playVideo();
    this.anchor = { yt: from, at: performance.now() };
    this.out = from;
    this.lastYt = -1;
    this.state = 'waiting';
  }

  pause(): void {
    this.wantPlaying = false;
    this.pendingPlay = null;
    if (this.ready) this.player?.pauseVideo();
    this.state = 'paused';
  }

  time(): number {
    const p = this.player;
    if (!p || !this.ready || this.state === 'error') return this.out;
    const now = performance.now();
    const yt = p.getCurrentTime();
    const ps = p.getPlayerState(); // -1 unstarted, 0 ended, 1 playing, 2 paused, 3 buffering, 5 cued
    if (ps === 0) {
      this.state = 'ended';
      return this.out;
    }
    // Started or paused with the video's own controls / a tap on the video.
    if (ps === 1 && !this.wantPlaying && this.controls) {
      this.wantPlaying = true;
      this.anchor = { yt, at: now };
      this.out = yt;
    }
    if (!this.wantPlaying) return this.out;
    if (ps === 2) {
      this.state = 'paused';
      this.out = yt;
      this.lastYt = yt;
      this.anchor = { yt, at: now };
      return this.out;
    }

    // The player's time updates in steps; re-anchor whenever it moves, and
    // interpolate in between for smooth notes.
    if (yt !== this.lastYt) {
      if (this.lastYt >= 0 || ps === 1) this.anchor = { yt, at: now };
      this.lastYt = yt;
    }
    const predicted = this.anchor.yt + (now - this.anchor.at) / 1000;
    const stalled = now - this.anchor.at > 700; // time hasn't moved: buffering or an ad
    if (ps === 1 && !stalled) {
      this.state = 'playing';
      // Never jump backwards by small jitters; follow real seeks.
      this.out = Math.abs(predicted - this.out) > 0.5 ? predicted : Math.max(this.out, predicted);
    } else if (ps === -1 || ps === 5) {
      // Not started: the browser may be blocking playback until someone taps the video.
      this.state = now - this.playRequestedAt > 2500 ? 'blocked' : 'waiting';
    } else {
      this.state = 'waiting';
    }
    return this.out;
  }

  destroy(): void {
    this.player?.destroy();
    this.player = null;
    this.host.replaceChildren();
  }
}
