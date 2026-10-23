/**
 * 3D for games, on three.js. A separate entry point so games that don't use 3D don't
 * carry it:
 *
 *   import * as THREE from '@trackergame/sdk/three';
 *   import { createStage3D } from '@trackergame/sdk/three';
 *
 * Draw the 3D scene on one canvas and keep 2D UI (drawText, DwellMenu, RoundFlow overlay)
 * on a second, transparent canvas on top — the SDK's 2D helpers all work there unchanged.
 */
import * as THREE from 'three';

export * from 'three';

export interface Stage3D {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  /** Match the canvas's CSS size and the device pixel ratio; returns the CSS size. Call each frame. */
  resize(): { w: number; h: number };
  render(): void;
}

/**
 * A renderer, scene and perspective camera for a full-window canvas, kept the right size
 * (pixel ratio capped at 2: a 4K TV doesn't need more, and it keeps the GPU cool).
 */
export function createStage3D(canvas: HTMLCanvasElement, opts: { fov?: number; background?: THREE.ColorRepresentation } = {}): Stage3D {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  const scene = new THREE.Scene();
  if (opts.background !== undefined) scene.background = new THREE.Color(opts.background);
  const camera = new THREE.PerspectiveCamera(opts.fov ?? 50, 16 / 9, 0.1, 1000);
  let lastW = 0;
  let lastH = 0;
  const resize = () => {
    const w = canvas.clientWidth || innerWidth;
    const h = canvas.clientHeight || innerHeight;
    if (w !== lastW || h !== lastH) {
      lastW = w;
      lastH = h;
      renderer.setPixelRatio(Math.min(2, devicePixelRatio || 1));
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    }
    return { w, h };
  };
  return { renderer, scene, camera, resize, render: () => renderer.render(scene, camera) };
}

/** A texture from an already-loaded image (e.g. from loadAssets), in the right colour space. */
export function textureFrom(img: HTMLImageElement | HTMLCanvasElement): THREE.Texture {
  const t = img instanceof HTMLCanvasElement ? new THREE.CanvasTexture(img) : new THREE.Texture(img);
  t.colorSpace = THREE.SRGBColorSpace;
  t.needsUpdate = true;
  return t;
}

/** A flat picture standing in the scene (a cut-out PNG with transparency), `height` units tall. */
export function billboard(img: HTMLImageElement, height: number, faceCamera = true): THREE.Object3D {
  const map = textureFrom(img);
  const width = (height * img.width) / img.height;
  if (faceCamera) {
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map, transparent: true }));
    s.scale.set(width, height, 1);
    return s;
  }
  const m = new THREE.Mesh(new THREE.PlaneGeometry(width, height), new THREE.MeshBasicMaterial({ map, transparent: true, side: THREE.DoubleSide }));
  return m;
}
