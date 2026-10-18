import type { InputSource, RawPose } from '../types';

/** The saved "camera" choice that means: use the native tracker (see savedCamera()). */
export const NATIVE_TRACKER_ID = 'native-tracker';
export const NATIVE_TRACKER_LABEL = 'Native tracker (tracker/, ws://127.0.0.1:8765)';

/**
 * Receives poses from the native tracker process (tracker/tracker.py: RTMO on
 * OpenVINO) over WebSocket. One pass finds every player, so it stays smooth with 4.
 *
 * Wire format (one JSON message per camera frame):
 *   { "aspect": 1.333, "poses": [ [[x, y, score] × 17], ... ], "stats"?: {...} }
 * x/y normalised 0..1 in UN-mirrored camera space, COCO-17 keypoint order.
 * Sending { "preview": true } also gets small JPEG camera frames (binary messages).
 */
export class WebSocketSource implements InputSource {
  readonly name = 'websocket';
  aspect = 4 / 3;
  private ws: WebSocket | null = null;
  private cb: ((poses: RawPose[], t: number) => void) | null = null;
  private msgs = 0;
  private fps = 0;
  private fpsT = 0;
  private closed = false;
  private connected = false;
  private serverStats: Record<string, number | string> = {};
  private wantPreview = false;
  private image: ImageBitmap | null = null;
  private decoding = false;

  constructor(
    private url = 'ws://127.0.0.1:8765',
    private onStatus: (message: string) => void = () => {},
  ) {}

  onPoses(cb: (poses: RawPose[], t: number) => void): void {
    this.cb = cb;
  }

  /**
   * Resolves once connected. Keeps retrying while the tracker isn't running yet
   * (on the box the browser may start first), and reconnects if it restarts.
   */
  start(): Promise<void> {
    return new Promise((resolve) => {
      let tries = 0;
      const connect = () => {
        if (this.closed) return;
        const ws = new WebSocket(this.url);
        ws.binaryType = 'blob';
        this.ws = ws;
        ws.onopen = () => {
          this.connected = true;
          if (this.wantPreview) ws.send(JSON.stringify({ preview: true }));
          resolve();
        };
        ws.onclose = () => {
          this.connected = false;
          if (this.closed) return;
          if (++tries === 2) this.onStatus(`Waiting for the tracker at ${this.url} (run: npm run tracker)…`);
          setTimeout(connect, 1000);
        };
        ws.onmessage = (ev) => (typeof ev.data === 'string' ? this.onFrame(ev.data) : this.onPreview(ev.data));
      };
      connect();
    });
  }

  private onFrame(data: string) {
    const msg = JSON.parse(data) as { aspect?: number; poses: number[][][]; stats?: Record<string, number | string> };
    if (msg.aspect) this.aspect = msg.aspect;
    if (msg.stats) this.serverStats = msg.stats;
    const t = performance.now();
    this.msgs++;
    if (t - this.fpsT > 1000) {
      this.fps = (this.msgs * 1000) / (t - this.fpsT);
      this.msgs = 0;
      this.fpsT = t;
    }
    this.cb?.(
      msg.poses.map((p) => p.map(([x, y, score]) => ({ x, y, score }))),
      t,
    );
  }

  private onPreview(blob: Blob) {
    if (this.decoding) return; // still busy with the last one: skip
    this.decoding = true;
    createImageBitmap(blob)
      .then((img) => {
        this.image?.close();
        this.image = img;
      })
      .catch(() => {})
      .finally(() => (this.decoding = false));
  }

  /** Latest small camera frame from the tracker (asks for them on first call). */
  preview(): ImageBitmap | null {
    if (!this.wantPreview) {
      this.wantPreview = true;
      if (this.connected) this.ws?.send(JSON.stringify({ preview: true }));
    }
    return this.image;
  }

  stop(): void {
    this.closed = true;
    this.ws?.close();
    this.image?.close();
  }

  stats() {
    return {
      source: `native tracker ${this.url}${this.connected ? '' : ' (disconnected)'}`,
      ...this.serverStats,
      fps: this.fps.toFixed(1),
    };
  }
}
