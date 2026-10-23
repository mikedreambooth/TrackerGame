/**
 * Which way up the camera is mounted. The tracker turns the picture before tracking (pose
 * models expect people the right way up); the page tells it on connect.
 *
 * Chosen on the debug page and remembered on this device; ?rotate=0|180 in the URL wins.
 * Default 180: the box's camera hangs upside down under the TV.
 */
export type Rotation = 0 | 180;
export const DEFAULT_ROTATION: Rotation = 180;
const KEY = 'trackergame.rotation';

const parse = (v: string | null): Rotation | null => (v === '0' ? 0 : v === '180' ? 180 : null);

export function savedRotation(): Rotation {
  const fromUrl = typeof location !== 'undefined' ? parse(new URLSearchParams(location.search).get('rotate')) : null;
  if (fromUrl !== null) return fromUrl;
  try {
    return parse(localStorage.getItem(KEY)) ?? DEFAULT_ROTATION;
  } catch {
    return DEFAULT_ROTATION;
  }
}

export function saveRotation(r: Rotation): void {
  try {
    localStorage.setItem(KEY, String(r));
  } catch {
    // Storage blocked: the choice just won't stick.
  }
}
