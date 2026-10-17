import type { InputSource, RawPose } from '../types';

/**
 * Receives poses from a separate native tracker process (e.g. Python + YOLO-pose
 * on ONNX/OpenVINO) over WebSocket. This is the planned upgrade path for
 * smooth 4-player tracking.
 *
 * Wire format (one JSON message per camera frame):
 *   { "aspect": 1.333, "poses": [ [[x, y, score] × 17], ... ] }
 * x/y normalised 0..1 in UN-mirrored camera space, COCO-17 keypoint order.
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

  constructor(private url = 'ws://localhost:8765') {}

  onPoses(cb: (poses: RawPose[], t: number) => void): void {
    this.cb = cb;
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error(`Could not connect to tracker at ${this.url}`));
      ws.onclose = () => {
        if (!this.closed) setTimeout(() => this.start().catch(() => {}), 1000);
      };
      ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data as string) as { aspect?: number; poses: number[][][] };
        if (msg.aspect) this.aspect = msg.aspect;
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
      };
    });
  }

  stop(): void {
    this.closed = true;
    this.ws?.close();
  }

  stats() {
    return { source: `websocket ${this.url}`, fps: this.fps.toFixed(1) };
  }
}
