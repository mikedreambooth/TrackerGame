import type { InputSource, RawPose } from '../types';

/** MediaPipe's 33 landmarks → our COCO-17 order. */
const MP_TO_COCO = [0, 2, 5, 7, 8, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28];

export interface MediaPipeOptions {
  /** Where fetch-assets.mjs put the wasm + model files. */
  assetBase?: string;
  model?: 'lite' | 'full';
  maxPoses?: number;
  /** Pick a specific camera (see listCameras()). Defaults to the first one. */
  deviceId?: string;
  width?: number;
  height?: number;
  fps?: number;
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
  private opts: Required<Omit<MediaPipeOptions, 'deviceId'>> & { deviceId?: string };

  constructor(opts: MediaPipeOptions = {}) {
    this.opts = {
      assetBase: opts.assetBase ?? '/vendor/mediapipe',
      model: opts.model ?? 'lite',
      maxPoses: opts.maxPoses ?? 4,
      deviceId: opts.deviceId,
      width: opts.width ?? 640,
      height: opts.height ?? 480,
      fps: opts.fps ?? 60,
    };
    this.video = document.createElement('video');
    this.video.playsInline = true;
    this.video.muted = true;
  }

  onPoses(cb: (poses: RawPose[], t: number) => void): void {
    this.cb = cb;
  }

  async start(): Promise<void> {
    const { assetBase, model, maxPoses, deviceId, width, height, fps } = this.opts;

    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        width: { ideal: width },
        height: { ideal: height },
        frameRate: { ideal: fps },
      },
    });
    this.video.srcObject = this.stream;
    await this.video.play();
    this.aspect = this.video.videoWidth / this.video.videoHeight || 4 / 3;

    const vision = await import('@mediapipe/tasks-vision');
    const fileset = await vision.FilesetResolver.forVisionTasks(`${assetBase}/wasm`);
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
      this.landmarker = await make('GPU');
      this.delegate = 'GPU';
    } catch (e) {
      console.warn('[mediapipe] GPU delegate failed, using CPU', e);
      this.landmarker = await make('CPU');
      this.delegate = 'CPU';
    }

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
