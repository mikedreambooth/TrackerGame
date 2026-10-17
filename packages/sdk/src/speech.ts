/**
 * Text-to-speech for games, using the browser's built-in Web Speech API.
 * No downloads, works offline with the device's own voices.
 *
 *   await say('On your marks!');            // resolves when finished speaking
 *   say('Red wins!', { interrupt: true });  // cut off whatever is being said
 *
 * Voices differ per device. On the Linux box, install a speech engine for
 * Chromium to use (deploy/setup-kiosk.sh does: speech-dispatcher + espeak-ng).
 * The function never throws: with no voice available it just resolves.
 */
export interface SayOptions {
  /** Stop anything currently being said first. Default false (queue after it). */
  interrupt?: boolean;
  /** 0.1–10, default 1. */
  rate?: number;
  /** 0–2, default 1.1 (a touch brighter for kids' games). */
  pitch?: number;
  /** 0–1, default 1. */
  volume?: number;
  /** BCP-47 language, default 'en-GB'. */
  lang?: string;
}

const synth = (): SpeechSynthesis | null =>
  typeof window !== 'undefined' && 'speechSynthesis' in window ? window.speechSynthesis : null;

let voices: SpeechSynthesisVoice[] = [];
const loadVoices = () => {
  voices = synth()?.getVoices() ?? [];
};
if (synth()) {
  loadVoices();
  synth()!.addEventListener?.('voiceschanged', loadVoices);
}

/** True if this browser can speak at all. */
export function speechAvailable(): boolean {
  return !!synth();
}

/** Best voice for a language: exact match first, natural-sounding names preferred. */
function pickVoice(lang: string): SpeechSynthesisVoice | undefined {
  if (!voices.length) loadVoices();
  const base = lang.split('-')[0];
  const score = (v: SpeechSynthesisVoice) =>
    (v.lang === lang ? 4 : v.lang.startsWith(base) ? 2 : 0) +
    (/natural|neural|google|premium|enhanced|siri/i.test(v.name) ? 1 : 0) +
    (v.localService ? 0.5 : 0);
  return [...voices].sort((a, b) => score(b) - score(a)).find((v) => v.lang.startsWith(base));
}

/** Speak some text. Resolves when it has been spoken (or immediately if speech is unavailable). */
export function say(text: string, opts: SayOptions = {}): Promise<void> {
  const s = synth();
  if (!s || !text.trim()) return Promise.resolve();
  if (opts.interrupt) s.cancel();
  return new Promise((resolve) => {
    const u = new SpeechSynthesisUtterance(text);
    u.lang = opts.lang ?? 'en-GB';
    u.rate = opts.rate ?? 1;
    u.pitch = opts.pitch ?? 1.1;
    u.volume = opts.volume ?? 1;
    const v = pickVoice(u.lang);
    if (v) u.voice = v;
    // Some engines never fire 'end' — don't let a game wait forever.
    const timer = setTimeout(resolve, 1500 + text.length * 120);
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    u.onend = done;
    u.onerror = done;
    s.speak(u);
  });
}

/** Stop speaking immediately and clear the queue. */
export function stopSpeaking(): void {
  synth()?.cancel();
}
