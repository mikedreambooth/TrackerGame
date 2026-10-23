/**
 * When feet count as badly placed, in camera-height fractions (0 = top of the picture,
 * 1 = bottom). With the camera at TV height and a typical 4:3 webcam, feet at 0.78 means
 * standing roughly 3.5 m back: the player is small on screen and their raised hands
 * barely reach the top of the menus.
 */
export const FEET = {
  /** Too far back: the lower foot is above this line… */
  highY: 0.78,
  /** …until it comes back below this one (hysteresis). */
  highClearY: 0.81,
  /** Too close: ankles out of the picture, or right at its bottom edge (below this). */
  edgeY: 0.97,
  /** A problem must last this long before the feet flash (ignores jumps and kicks). */
  warnAfterMs: 1200,
  /** Keypoints below this confidence don't count as seen. */
  minScore: 0.3,
};
