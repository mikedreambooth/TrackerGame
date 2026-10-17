/**
 * Tempo + beat-phase detection for audio files (not possible for YouTube —
 * its audio isn't readable by the page).
 *
 *  1. Onset strength: rise in log energy, frame by frame (~11.6 ms hops).
 *  2. Tempo: autocorrelation of the onset curve over 70–180 BPM, gently
 *     preferring 90–140 BPM (comfortable to move to).
 *  3. Phase: the grid offset whose beats line up with the strongest onsets.
 *
 * Good on steady-tempo instrumental music, which is what the game ships with.
 */

export interface BeatInfo {
  bpm: number;
  /** Time (s) of a beat; the grid is offset + k * 60/bpm. */
  offset: number;
  /** 0..1, how clearly the tempo stood out. */
  confidence: number;
}

const HOP = 512;

export function detectBeat(samples: Float32Array, sampleRate: number): BeatInfo {
  // 1. Onset strength envelope.
  const frames = Math.floor(samples.length / HOP);
  const energy = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let e = 0;
    const base = f * HOP;
    for (let i = 0; i < HOP; i++) {
      const v = samples[base + i];
      e += v * v;
    }
    energy[f] = Math.log(1e-6 + e);
  }
  const onset = new Float32Array(frames);
  for (let f = 1; f < frames; f++) onset[f] = Math.max(0, energy[f] - energy[f - 1]);
  // Remove the slowly varying part so only sharp attacks remain.
  const smooth = 16;
  let acc = 0;
  const local = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    acc += onset[f] - (f >= smooth ? onset[f - smooth] : 0);
    local[f] = Math.max(0, onset[f] - acc / Math.min(f + 1, smooth));
  }

  // 2. Tempo by autocorrelation.
  const fps = sampleRate / HOP;
  const minLag = Math.floor((60 / 180) * fps);
  const maxLag = Math.ceil((60 / 70) * fps);
  const scores: number[] = [];
  let best = minLag;
  let bestScore = -Infinity;
  let total = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let s = 0;
    for (let f = lag; f < frames; f++) s += local[f] * local[f - lag];
    const bpm = (60 * fps) / lag;
    // Prefer comfortable tempos a little (log-Gaussian around 120 BPM).
    const pref = Math.exp(-0.5 * (Math.log2(bpm / 120) / 0.9) ** 2);
    const score = s * pref;
    scores.push(score);
    total += score;
    if (score > bestScore) {
      bestScore = score;
      best = lag;
    }
  }
  // Parabolic refinement of the peak for a fractional lag.
  const i = best - minLag;
  let lag = best;
  if (i > 0 && i < scores.length - 1) {
    const a = scores[i - 1];
    const b = scores[i];
    const c = scores[i + 1];
    const d = a - 2 * b + c;
    if (d < 0) lag = best + (0.5 * (a - c)) / d;
  }
  const confidence = Math.min(1, bestScore / (total / scores.length) / 6);

  // 3. Fine tempo + phase together: try tempos within ±2% of the estimate and
  // every phase, keeping the grid that lines up with the most onset energy over
  // the whole song. (A 0.5% tempo error drifts ~0.5 s by the end of a song.)
  const grid = (period: number) => {
    let bestSum = -Infinity;
    let phase = 0;
    for (let p = 0; p < period; p += 0.5) {
      let sum = 0;
      for (let f = p; f < frames - 1; f += period) {
        const k = Math.floor(f);
        const w = f - k;
        sum += local[k] * (1 - w) + local[k + 1] * w;
      }
      if (sum > bestSum) {
        bestSum = sum;
        phase = p;
      }
    }
    return { sum: bestSum, phase };
  };
  let bestPeriod = lag;
  let best2 = grid(lag);
  for (let r = -0.02; r <= 0.02; r += 0.0005) {
    const period = lag * (1 + r);
    const g = grid(period);
    if (g.sum > best2.sum) {
      best2 = g;
      bestPeriod = period;
    }
  }
  const fineBpm = (60 * fps) / bestPeriod;
  return {
    bpm: Math.round(fineBpm * 100) / 100,
    offset: (best2.phase * HOP) / sampleRate,
    confidence,
  };
}

/** Fetch + decode a file (no audio playback needed) and detect its beat. */
export async function analyzeUrl(url: string): Promise<BeatInfo & { duration: number }> {
  const buf = await (await fetch(url)).arrayBuffer();
  const ctx = new OfflineAudioContext(1, 1, 44100);
  const audio = await ctx.decodeAudioData(buf);
  // Mix to mono.
  const mono = new Float32Array(audio.length);
  for (let c = 0; c < audio.numberOfChannels; c++) {
    const d = audio.getChannelData(c);
    for (let i = 0; i < d.length; i++) mono[i] += d[i] / audio.numberOfChannels;
  }
  return { ...detectBeat(mono, audio.sampleRate), duration: audio.duration };
}
