import type { InputSource, RawPose } from '../types';

/** MediaPipe's 33 landmarks → our COCO-17 order. */
const MP_TO_COCO = [0, 2, 5, 7, 8, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28];

export interface MediaPipeOptions {
  /** Where the wasm + model files are served. Defaults to `vendor/mediapipe` next to the page's site root. */
  assetBase?: string;
  model?: 'lite' | 'full';
  maxPoses?: number;
  /** Pick a specific camera (see listCameras()). Defaults to the first one. */
  deviceId?: string;
  width?: number;
  height?: number;
  fps?: number;
  /** Progress messages while starting ("Waiting for camera permission…" etc.). */
  onStatus?: (message: string) => void;
}

/** Reject if a step takes too long, so a stuck step shows up as an error instead of a hang. */
function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what} timed out after ${Math.round(ms / 1000)} s`)), ms);
    p.then(
      (v) => (clearTimeout(t), resolve(v)),
      (e) => (clearTimeout(t), reject(e)),
    );
  });
}

/** List available cameras (labels only appear after camera permission is granted). */
export async function listCameras(): Promise<MediaDeviceInfo[]> {
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices.filter((d) => d.kind === 'videoinput');
}

/**
 * Runs MediaPipe Pose Landmarker in the browser (WebGL/GPU when available).
 * Good for 1–2 players and for getting started. For 4 players, swap in
 * WebSocketSource fed by a native single-pass model (YOLO-pose / RTMO) —
 * games won't notice the difference.
 */
export class MediaPipeSource implements InputSource {
  readonly name = 'mediapipe';
  video: HTMLVideoElement;
  aspect = 4 / 3;

  private cb: ((poses: RawPose[], t: number) => void) | null = null;
  private landmarker: any = null;
  private stream: MediaStream | null = null;
  private running = false;
  private lastVideoTime = -1;
  private inferMs = 0;
  private fps = 0;
  private frames = 0;
  private fpsT = 0;
  private delegate = '';
  private opts: Required<Omit<MediaPipeOptions, 'deviceId' | 'onStatus'>> & { deviceId?: string };
  private status: (m: string) => void;

  constructor(opts: MediaPipeOptions = {}) {
    this.opts = {
      assetBase: opts.assetBase ?? new URL('vendor/mediapipe', document.baseURI).href,
      model: opts.model ?? 'lite',
      maxPoses: opts.maxPoses ?? 4,
      deviceId: opts.deviceId,
      width: opts.width ?? 640,
      height: opts.height ?? 480,
      fps: opts.fps ?? 60,
    };
    this.status = opts.onStatus ?? (() => {});
    this.video = document.createElement('video');
    this.video.playsInline = true;
    this.video.muted = true;
    this.video.autoplay = true;
    this.video.setAttribute('playsinline', '');
    this.video.setAttribute('muted', '');
    // iOS Safari won't reliably play a <video> that isn't in the page, so attach it, invisibly.
    this.video.setAttribute(
      'style',
      'position:fixed;left:0;top:0;width:2px;height:2px;opacity:0.01;pointer-events:none;z-index:-1',
    );
  }

  onPoses(cb: (poses: RawPose[], t: number) => void): void {
    this.cb = cb;
  }

  async start(): Promise<void> {
    const { assetBase, model, maxPoses, deviceId, width, height, fps } = this.opts;

    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('This browser gives no camera access here (open the page in Safari/Chrome itself, over https)');
    }
    this.status('Waiting for camera permission…');
    this.stream = await withTimeout(
      navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          deviceId: deviceId ? { exact: deviceId } : undefined,
          facingMode: deviceId ? undefined : 'user',
          width: { ideal: width },
          height: { ideal: height },
          frameRate: { ideal: fps },
        },
      }),
      60_000,
      'Camera permission',
    );
    this.status('Starting camera…');
    if (!this.video.isConnected) document.body.append(this.video);
    this.video.srcObject = this.stream;
    await withTimeout(this.video.play(), 10_000, 'Starting the camera video');
    this.aspect = this.video.videoWidth / this.video.videoHeight || 4 / 3;

    this.status('Loading pose model (about 15 MB the first time)…');
    const vision = await withTimeout(import('@mediapipe/tasks-vision'), 60_000, 'Loading the pose library');
    const fileset = await withTimeout(
      vision.FilesetResolver.forVisionTasks(`${assetBase}/wasm`),
      60_000,
      'Loading the pose runtime',
    );
    const make = (delegate: 'GPU' | 'CPU') =>
      vision.PoseLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: `${assetBase}/pose_landmarker_${model}.task`, delegate },
        runningMode: 'VIDEO',
        numPoses: maxPoses,
        minPoseDetectionConfidence: 0.5,
        minPosePresenceConfidence: 0.5,
        minTrackingConfidence: 0.5,
      });
    try {
      this.status('Starting pose model on the GPU…');
      this.landmarker = await withTimeout(make('GPU'), 30_000, 'GPU pose model');
      this.delegate = 'GPU';
    } catch (e) {
      console.warn('[mediapipe] GPU delegate failed, using CPU', e);
      this.status('GPU unavailable — starting pose model on the CPU…');
      this.landmarker = await withTimeout(make('CPU'), 60_000, 'CPU pose model');
      this.delegate = 'CPU';
    }
    this.status('Tracking');

    this.running = true;
    this.fpsT = performance.now();
    this.loop();
  }

  private loop = (): void => {
    if (!this.running) return;
    const v = this.video;
    if (v.readyState >= 2 && v.currentTime !== this.lastVideoTime) {
      this.lastVideoTime = v.currentTime;
      const t = performance.now();
      const result = this.landmarker.detectForVideo(v, t);
      this.inferMs = performance.now() - t;
      const poses: RawPose[] = (result.landmarks ?? []).map((lm: any[]) =>
        MP_TO_COCO.map((i) => ({ x: lm[i].x, y: lm[i].y, score: lm[i].visibility ?? 1 })),
      );
      this.frames++;
      if (t - this.fpsT > 1000) {
        this.fps = (this.frames * 1000) / (t - this.fpsT);
        this.frames = 0;
        this.fpsT = t;
      }
      this.cb?.(poses, t);
    }
    // requestVideoFrameCallback fires once per new camera frame where supported.
    if ('requestVideoFrameCallback' in v) (v as any).requestVideoFrameCallback(this.loop);
    else requestAnimationFrame(this.loop);
  };

  stop(): void {
    this.running = false;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.landmarker?.close?.();
  }

  stats() {
    const s = this.stream?.getVideoTracks()[0]?.getSettings();
    return {
      source: `mediapipe-${this.opts.model} (${this.delegate})`,
      camera: s ? `${s.width}x${s.height}@${Math.round(s.frameRate ?? 0)}` : '-',
      fps: this.fps.toFixed(1),
      inferMs: this.inferMs.toFixed(1),
    };
  }
}
