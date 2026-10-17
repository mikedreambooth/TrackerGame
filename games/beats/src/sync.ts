/**
 * Tap-along setup (Song Editor): turn a grown-up's taps on the beat (song
 * seconds) into a beat grid.
 *
 *  - tempo: the median gap between taps (folded into a 0.33–0.8 s beat), then a
 *    least-squares fit over all taps — or the song's known BPM if given;
 *  - phase: circular average of where each tap falls within the beat;
 *  - quality: how tightly the taps agree (0..1). Below ~0.8, tap again.
 */
export interface SyncResult {
  bpm: number;
  offset: number;
  quality: number;
}

export function fitTaps(claps: number[], bpmHint?: number): SyncResult | null {
  if (claps.length < 4) return null;
  let period: number;
  if (bpmHint) period = 60 / bpmHint;
  else {
    const gaps = claps
      .slice(1)
      .map((c, i) => c - claps[i])
      .filter((g) => g > 0.2 && g < 2.5)
      .sort((a, b) => a - b);
    if (!gaps.length) return null;
    period = gaps[Math.floor(gaps.length / 2)];
    while (period > 0.8) period /= 2;
    while (period < 0.33) period *= 2;
    // Refine: number each clap's beat, then least-squares fit time = a + period * beat.
    const idx = claps.map((c) => Math.round((c - claps[0]) / period));
    const n = claps.length;
    const mi = idx.reduce((s, v) => s + v, 0) / n;
    const mc = claps.reduce((s, v) => s + v, 0) / n;
    let num = 0;
    let den = 0;
    for (let i = 0; i < n; i++) {
      num += (idx[i] - mi) * (claps[i] - mc);
      den += (idx[i] - mi) ** 2;
    }
    if (den > 0) period = num / den;
  }
  // Circular mean of the claps' phase within one beat.
  let sx = 0;
  let sy = 0;
  for (const c of claps) {
    const a = ((c % period) / period) * Math.PI * 2;
    sx += Math.cos(a);
    sy += Math.sin(a);
  }
  const quality = Math.hypot(sx, sy) / claps.length;
  let angle = Math.atan2(sy, sx);
  if (angle < 0) angle += Math.PI * 2;
  return { bpm: Math.round((60 / period) * 100) / 100, offset: (angle / (Math.PI * 2)) * period, quality };
}
