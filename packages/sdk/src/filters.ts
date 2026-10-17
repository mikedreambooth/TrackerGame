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

  constructor(
    private minCutoff = 1.7,
    private beta = 0.3,
    private dCutoff = 1.0,
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
