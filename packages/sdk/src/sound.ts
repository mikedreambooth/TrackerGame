/**
 * Tiny synth for game sound effects — no audio files needed.
 * Browsers only allow audio after a user gesture; the kiosk launches Chromium
 * with --autoplay-policy=no-user-gesture-required so this just works on the box.
 */
let ac: AudioContext | null = null;
/** The shared AudioContext used by blip/noise and loadAssets() sounds. */
export const audioContext = () => (ac ??= new AudioContext());
const ctx = audioContext;

export function blip(freq = 660, ms = 120, type: OscillatorType = 'sine', volume = 0.2, slideTo?: number) {
  try {
    const a = ctx();
    const o = a.createOscillator();
    const g = a.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, a.currentTime);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, a.currentTime + ms / 1000);
    g.gain.setValueAtTime(volume, a.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, a.currentTime + ms / 1000);
    o.connect(g).connect(a.destination);
    o.start();
    o.stop(a.currentTime + ms / 1000);
  } catch {
    /* audio unavailable */
  }
}

export function noise(ms = 200, volume = 0.3) {
  try {
    const a = ctx();
    const len = Math.floor((a.sampleRate * ms) / 1000);
    const buf = a.createBuffer(1, len, a.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = a.createBufferSource();
    const g = a.createGain();
    g.gain.value = volume;
    src.buffer = buf;
    src.connect(g).connect(a.destination);
    src.start();
  } catch {
    /* audio unavailable */
  }
}
