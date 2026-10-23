/** Pixel art drawn on tiny canvases, shown in 3D with nearest filtering. */
import * as THREE from '@trackergame/sdk/three';

export type Rgb = number[];

/** A seeded random, so the pixel art is the same every time. */
export function seeded(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
}
export const rgb = (hex: string): Rgb => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
export const shade = (c: Rgb, k: number): Rgb => c.map((v) => v * k);
export const mixRgb = (a: Rgb, b: Rgb, k: number): Rgb => a.map((v, i) => v + (b[i] - v) * k);
export const css = (c: Rgb) => `rgb(${c.map((v) => Math.round(Math.max(0, Math.min(255, v)))).join(',')})`;

let anisotropy = 1;
/** Set once from the renderer (renderer.capabilities.getMaxAnisotropy()). */
export function setAnisotropy(a: number) {
  anisotropy = a;
}

/** A texture from a small canvas, pixel-art filtered, repeating. */
export function canvasTexture(c: HTMLCanvasElement): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.magFilter = THREE.NearestFilter;
  t.minFilter = THREE.NearestMipmapLinearFilter;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = anisotropy;
  return t;
}

/** A w × h pixel-art canvas: `px(x, y)` gives each pixel's [r, g, b] (or [r, g, b, a]). */
export function pixelCanvas(w: number, h: number, px: (x: number, y: number) => Rgb): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d')!;
  const img = g.createImageData(w, h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const [r, gg, b, a = 255] = px(x, y);
      const i = (y * w + x) * 4;
      img.data[i] = r;
      img.data[i + 1] = gg;
      img.data[i + 2] = b;
      img.data[i + 3] = a;
    }
  g.putImageData(img, 0, 0);
  return c;
}

export const pixelTexture = (w: number, h: number, px: (x: number, y: number) => Rgb) => canvasTexture(pixelCanvas(w, h, px));

/** A second texture over the same pixels (own repeat/offset). */
export function retile(t: THREE.Texture, rx: number, ry: number): THREE.Texture {
  const c = t.clone();
  c.repeat.set(rx, ry);
  c.needsUpdate = true;
  return c;
}

/** 3 × 5 pixel digits, for podium numbers. */
const DIGITS: Record<string, string> = {
  '1': '010110010010111',
  '2': '111001111100111',
  '3': '111001111001111',
  '4': '101101111001001',
};

/** A block face: `base` with a border, and a big pixel digit in `ink`. */
export function digitTexture(d: string, base: Rgb, ink: Rgb): THREE.CanvasTexture {
  const bits = DIGITS[d] ?? DIGITS['1'];
  return pixelTexture(16, 16, (x, y) => {
    if (x === 0 || y === 0 || x === 15 || y === 15) return shade(base, 0.6);
    if (y === 1 || x === 1) return mixRgb(base, [255, 255, 255], 0.4);
    // Digit cells are 2 × 2 pixels, centred: columns 5..10, rows 3..12.
    const cx = Math.floor((x - 5) / 2);
    const cy = Math.floor((y - 3) / 2);
    if (cx >= 0 && cx < 3 && cy >= 0 && cy < 5 && bits[cy * 3 + cx] === '1') return ink;
    return shade(base, 0.92 + ((x * 7 + y * 13) % 5) * 0.03);
  });
}
