/**
 * One Euro filter (Casiez et al. 2012): low jitter when still, low lag when
 * moving fast. Exactly what kids' flailing limbs need.
 */
function alpha(cutoff: number, dt: number): number {
  const tau = 1 / (2 * Math.PI * cutoff);
  return 1 / (1 + tau / dt);
}

export class OneEuro {
  private x: number | null = null;
  private dx = 0;
  private lastT = 0;

  // beta is per unit of speed, and our coordinates are 0..1 (a fast arm is ~2/s). The old
  // pixel-style 0.3 barely opened up: ~50 ms lag mid-swing, ~120 ms to catch up after a move.
  // 5 gives ~1 frame of lag with the same jitter when still. Velocity doesn't depend on beta.
  constructor(
    private minCutoff = 1.5,
    private beta = 5,
    private dCutoff = 1.0,
    /** false = pass values straight through (no smoothing); velocity is still estimated. */
    private smooth = true,
  ) {}

  /** t in ms. Returns the filtered value. */
  filter(value: number, t: number): number {
    if (this.x === null) {
      this.x = value;
      this.lastT = t;
      return value;
    }
    const dt = Math.max((t - this.lastT) / 1000, 1e-3);
    this.lastT = t;
    const rawDx = (value - this.x) / dt;
    this.dx += alpha(this.dCutoff, dt) * (rawDx - this.dx);
    if (!this.smooth) return (this.x = value);
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dx);
    this.x += alpha(cutoff, dt) * (value - this.x);
    return this.x;
  }

  /** Smoothed derivative, units per second. */
  get velocity(): number {
    return this.dx;
  }

  reset(): void {
    this.x = null;
    this.dx = 0;
  }
}
