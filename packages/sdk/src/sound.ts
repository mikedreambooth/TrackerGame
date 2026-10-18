/**
 * Tiny synth for game sound effects — no audio files needed.
 *
 * Browsers only allow audio after a user gesture. The kiosk launches Chromium
 * with --autoplay-policy=no-user-gesture-required; elsewhere (phones, normal
 * browsers) unlockAudio() unlocks it on the first touch/click/key. Inside the
 * launcher, games' audio is played by the launcher itself (see audio-relay.ts).
 */
import { audioId, relayAudio } from './audio-relay';

let ac: AudioContext | null = null;
/** The shared AudioContext used by blip/noise and loadAssets() sounds. */
export const audioContext = () => {
  ac ??= new AudioContext();
  if (ac.state === 'suspended') ac.resume().catch(() => {});
  return ac;
};

export function blip(freq = 660, ms = 120, type: OscillatorType = 'sine', volume = 0.2, slideTo?: number) {
  if (relayAudio({ op: 'blip', freq, ms, type, volume, slideTo })) return;
  try {
    const a = audioContext();
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
  if (relayAudio({ op: 'noise', ms, volume })) return;
  try {
    const a = audioContext();
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

/**
 * A piano note (MIDI number, 60 = middle C) that rings like a struck string and fades
 * naturally. Call the returned function to lift the key: the damper stops it quickly.
 */
export function pianoNote(midi: number, volume = 0.4): () => void {
  const id = audioId();
  if (relayAudio({ op: 'note', id, midi, volume })) return () => void relayAudio({ op: 'stop', id });
  try {
    const a = audioContext();
    const t = a.currentTime;
    const f = 440 * 2 ** ((midi - 69) / 12);
    // Low notes ring for longer.
    const ring = Math.min(6, Math.max(1, 1.5 + (84 - midi) * 0.09));
    const strike = a.createGain();
    strike.gain.setValueAtTime(0, t);
    strike.gain.linearRampToValueAtTime(volume, t + 0.004);
    strike.gain.setTargetAtTime(volume * 0.35, t + 0.004, 0.12); // quick drop after the hammer
    strike.gain.setTargetAtTime(0.0001, t + 0.3, ring / 3);
    const damper = a.createGain();
    // Bright at the strike, mellowing as it rings.
    const tone = a.createBiquadFilter();
    tone.type = 'lowpass';
    tone.frequency.setValueAtTime(Math.min(16000, f * 9), t);
    tone.frequency.setTargetAtTime(Math.min(12000, f * 3), t + 0.02, 0.4);
    strike.connect(tone).connect(damper).connect(a.destination);
    // Slightly stretched harmonics (real strings are a bit stiff), plus a detuned twin
    // of the fundamental for the shimmer of a piano's paired strings.
    const partials: [number, number][] = [[1, 1], [1.0009, 0.5], [2, 0.45], [3, 0.22], [4, 0.12], [5, 0.06], [6, 0.03]];
    const oscs = partials.map(([n, amp]) => {
      const o = a.createOscillator();
      const g = a.createGain();
      const k = Math.round(n);
      o.frequency.value = f * n * Math.sqrt(1 + 0.0004 * k * k);
      g.gain.value = amp * 0.45;
      o.connect(g).connect(strike);
      o.start(t);
      return o;
    });
    // A soft knock of the hammer felt.
    const len = Math.floor(a.sampleRate * 0.03);
    const buf = a.createBuffer(1, len, a.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 2;
    const knock = a.createBufferSource();
    const kf = a.createBiquadFilter();
    const kg = a.createGain();
    knock.buffer = buf;
    kf.type = 'bandpass';
    kf.frequency.value = Math.min(8000, f * 4);
    kg.gain.value = volume * 0.25;
    knock.connect(kf).connect(kg).connect(damper);
    knock.start(t);
    const end = t + ring * 2;
    oscs.forEach((o) => o.stop(end));
    let stopped = false;
    return () => {
      if (stopped) return;
      stopped = true;
      const now = a.currentTime;
      damper.gain.setTargetAtTime(0, now, 0.07);
      oscs.forEach((o) => o.stop(Math.min(end, now + 0.6)));
    };
  } catch {
    return () => {};
  }
}

let unlockInstalled = false;

/**
 * Make audio and speech work on browsers that require a user gesture (iOS
 * Safari especially): on the first touch, click or key press, resume the audio
 * context, play a silent sample and speak an empty utterance. Also asks iOS to
 * treat the page as media playback, so the ringer/silent switch doesn't mute
 * game sounds (Safari 17+). Safe to call more than once.
 */
export function unlockAudio(): void {
  if (unlockInstalled || typeof window === 'undefined') return;
  unlockInstalled = true;
  const session = (navigator as unknown as { audioSession?: { type: string } }).audioSession;
  if (session) {
    try {
      session.type = 'playback';
    } catch {
      /* not supported */
    }
  }
  const unlock = () => {
    try {
      const a = audioContext();
      const src = a.createBufferSource();
      src.buffer = a.createBuffer(1, 1, 22050);
      src.connect(a.destination);
      src.start(0);
      if ('speechSynthesis' in window) {
        const u = new SpeechSynthesisUtterance(' ');
        u.volume = 0;
        speechSynthesis.speak(u);
      }
    } catch {
      /* ignore */
    }
    if (ac?.state === 'running') {
      for (const ev of ['pointerdown', 'touchend', 'keydown']) removeEventListener(ev, unlock, true);
    }
  };
  for (const ev of ['pointerdown', 'touchend', 'keydown']) addEventListener(ev, unlock, true);
}
