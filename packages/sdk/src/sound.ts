/**
 * Tiny synth for game sound effects — no audio files needed.
 *
 * Browsers only allow audio after a user gesture. The kiosk launches Chromium
 * with --autoplay-policy=no-user-gesture-required; elsewhere (phones, normal
 * browsers) unlockAudio() unlocks it on the first touch/click/key. Inside the
 * launcher, games' audio is played by the launcher itself (see audio-relay.ts).
 */
import { relayAudio } from './audio-relay';

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
