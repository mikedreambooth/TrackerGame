import { savedRotation, type Rotation } from '../orientation';
import type { ServerFrame } from '../protocol';
import { smoothingFromUrl } from '../tracker';
import type { Cutout, InputSource, RawPose, Segmentation } from '../types';


/**
 * Receives players from the native tracker process (tracker/tracker.py: RTMO on OpenVINO,
 * then player tracking) over WebSocket. One pass finds every player, so it stays smooth with 4.
 *
 * Protocol (full description at the top of tracker/tracker.py). On every connect the page
 * sends {"v": 2, "rotate": 0 | 180} (+ {"smooth": false} with ?smooth=0): protocol v2, and
 * which way up the camera is (the tracker turns the picture before tracking). Then one JSON
 * message per camera frame:
 *   v2: {"v": 2, "t", "aspect", "players": [...], "events": [...], "detections", "stats"?}
 *       players tracked on the tracker: ids, smoothed MIRRORED keypoints, measures, poses,
 *       jump state, cursor… (ServerFrame in protocol.ts) → onFrame().
 *   v1 (older trackers): {"aspect", "poses": [[[x, y, score] × 17], ...], "stats"?} raw poses,
 *       UN-mirrored → onPoses(), tracked in the browser by PlayerTracker.
 * Sending {"preview": true} also gets small JPEG camera frames, and {"segment": true} a
 * cut-out picture of each person (binary messages: a type byte, then the data; each cut-out
 * says which player it is).
 */
export class WebSocketSource implements InputSource {
  readonly name = 'websocket';
  /** The tracker's default baseline (its --baseline), once it has said. */
  baseline?: number;
  aspect = 4 / 3;
  private ws: WebSocket | null = null;
  private cb: ((poses: RawPose[], t: number) => void) | null = null;
  private frameCb: ((frame: ServerFrame, t: number) => void) | null = null;
  private msgs = 0;
  private fps = 0;
  private fpsT = 0;
  private closed = false;
  private connected = false;
  private serverStats: Record<string, number | string> = {};
  private wantPreview = false;
  private image: ImageBitmap | null = null;
  private decoding = false;
  /** When segmentation() was last called (0: nobody wants cut-outs). */
  private segAsked = 0;
  private segSent = false;
  private seg: Segmentation | null = null;
  private segDecoding = false;
  private segTimer = 0;

  constructor(
    private url = 'ws://127.0.0.1:8765',
    private onStatus: (message: string) => void = () => {},
    private rotation: Rotation = savedRotation(),
    /** false (?smooth=0): ask the tracker for unsmoothed keypoints while this page is connected. */
    private smoothing = smoothingFromUrl(),
  ) {}

  onPoses(cb: (poses: RawPose[], t: number) => void): void {
    this.cb = cb;
  }

  /** Players tracked by the tracker (protocol v2). Older trackers send raw poses to onPoses instead. */
  onFrame(cb: (frame: ServerFrame, t: number) => void): void {
    this.frameCb = cb;
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
        ws.binaryType = 'arraybuffer';
        this.ws = ws;
        ws.onopen = () => {
          this.connected = true;
          ws.send(JSON.stringify({ v: 2, rotate: this.rotation }));
          if (!this.smoothing) ws.send(JSON.stringify({ smooth: false }));
          if (this.wantPreview) ws.send(JSON.stringify({ preview: true }));
          this.segSent = false;
          this.syncSegment();
          resolve();
        };
        ws.onclose = () => {
          this.connected = false;
          if (this.closed) return;
          if (++tries === 2) this.onStatus(`Waiting for the tracker at ${this.url} (run: npm run tracker)…`);
          setTimeout(connect, 1000);
        };
        ws.onmessage = (ev) => (typeof ev.data === 'string' ? this.onText(ev.data) : this.onBinary(ev.data));
      };
      connect();
    });
  }

  private onText(data: string) {
    const msg = JSON.parse(data) as {
      v?: number;
      aspect?: number;
      poses?: number[][][];
      stats?: Record<string, number | string>;
      config?: { baseline?: number };
    };
    // Settings the tracker announces on connect (not a frame).
    if (msg.config) {
      if (typeof msg.config.baseline === 'number') this.baseline = msg.config.baseline;
      return;
    }
    if (msg.aspect) this.aspect = msg.aspect;
    if (msg.stats) this.serverStats = msg.stats;
    const t = performance.now();
    this.msgs++;
    if (t - this.fpsT > 1000) {
      this.fps = (this.msgs * 1000) / (t - this.fpsT);
      this.msgs = 0;
      this.fpsT = t;
    }
    if (msg.v === 2) this.frameCb?.(msg as unknown as ServerFrame, t);
    else if (msg.poses)
      this.cb?.(
        msg.poses.map((p) => p.map(([x, y, score]) => ({ x, y, score }))),
        t,
      );
  }

  /** Binary messages start with a type byte: 1 = JPEG preview, 2 = person cut-outs. */
  private onBinary(buf: ArrayBuffer) {
    const type = new Uint8Array(buf, 0, 1)[0];
    if (type === 1) this.onPreview(new Blob([new Uint8Array(buf, 1)], { type: 'image/jpeg' }));
    else if (type === 2) this.onCutouts(buf);
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

  /** u32le JSON length, JSON {people: [{box, pose, player, anchor, bytes}]}, then each person's WebP. */
  private onCutouts(buf: ArrayBuffer) {
    if (this.segDecoding || !this.segAsked) return; // still busy with the last one: skip
    const len = new DataView(buf).getUint32(1, true);
    const head = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 5, len))) as {
      people: { box: [number, number, number, number]; pose: number; player?: number; anchor: [number, number] | null; bytes: number }[];
    };
    let at = 5 + len;
    const people = head.people.map((p) => {
      const blob = new Blob([new Uint8Array(buf, at, p.bytes)], { type: 'image/webp' });
      at += p.bytes;
      return createImageBitmap(blob).then(
        (image): Cutout => ({
          image,
          box: { x0: p.box[0], y0: p.box[1], x1: p.box[2], y1: p.box[3] },
          pose: p.pose,
          player: p.player,
          anchor: p.anchor ? { x: p.anchor[0], y: p.anchor[1] } : null,
        }),
      );
    });
    this.segDecoding = true;
    Promise.all(people)
      .then((list) => {
        this.dropSegmentation();
        this.seg = { t: performance.now(), people: list };
      })
      .catch(() => {})
      .finally(() => (this.segDecoding = false));
  }

  private dropSegmentation() {
    for (const c of this.seg?.people ?? []) (c.image as ImageBitmap).close();
    this.seg = null;
  }

  /** Tell the tracker whether cut-outs are still wanted (they stop ~2 s after the last ask). */
  private syncSegment() {
    const want = this.segAsked > 0 && performance.now() - this.segAsked < 2000;
    if (!want) {
      this.segAsked = 0;
      this.dropSegmentation();
    }
    if (want !== this.segSent && this.connected) {
      this.ws?.send(JSON.stringify({ segment: want }));
      this.segSent = want;
    }
  }

  /** Latest small camera frame from the tracker (asks for them on first call). */
  preview(): ImageBitmap | null {
    if (!this.wantPreview) {
      this.wantPreview = true;
      if (this.connected) this.ws?.send(JSON.stringify({ preview: true }));
    }
    return this.image;
  }

  /** Latest person cut-outs from the tracker. Asks for them while this keeps being called. */
  segmentation(): Segmentation | null {
    const first = !this.segAsked;
    this.segAsked = performance.now();
    if (first) {
      this.syncSegment();
      this.segTimer ||= window.setInterval(() => this.syncSegment(), 1000);
    }
    return this.seg;
  }

  stop(): void {
    this.closed = true;
    clearInterval(this.segTimer);
    this.ws?.close();
    this.image?.close();
    this.dropSegmentation();
  }

  stats() {
    return {
      source: `native tracker ${this.url}${this.connected ? '' : ' (disconnected)'}`,
      ...this.serverStats,
      fps: this.fps.toFixed(1),
    };
  }
}
