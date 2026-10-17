/**
 * Inside the launcher, games don't play audio themselves: iOS (and other
 * browsers without the kiosk's autoplay flag) only allow sound after a touch in
 * the same frame, and touches go to the launcher. So an embedded game sends
 * audio commands to the launcher, which plays them. Standalone games play
 * locally. Game code never needs to care — blip(), say() and loadAssets()
 * route automatically.
 */
import type { PlayOptions } from './assets';
import type { SayOptions } from './speech';

export type AudioCommand =
  | { op: 'blip'; freq: number; ms: number; type: OscillatorType; volume: number; slideTo?: number }
  | { op: 'noise'; ms: number; volume: number }
  | { op: 'say'; id: number; text: string; opts: SayOptions }
  | { op: 'stopSpeaking' }
  | { op: 'preload'; url: string }
  | { op: 'play'; id: number; url: string; opts: PlayOptions }
  | { op: 'stop'; id: number };

let relay: ((cmd: AudioCommand) => void) | null = null;
let nextId = 1;
const waiting = new Map<number, () => void>();

/** Set by createGame() when embedded: where audio commands go. */
export function setAudioRelay(fn: ((cmd: AudioCommand) => void) | null): void {
  relay = fn;
}

/** Send a command if relaying. Returns false when audio should play locally. */
export function relayAudio(cmd: AudioCommand): boolean {
  if (!relay) return false;
  relay(cmd);
  return true;
}

/** A fresh id for commands that are tracked (say → done, play → stop). */
export const audioId = () => nextId++;

/** Resolves when the host reports the command with this id finished. */
export function whenAudioDone(id: number, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      waiting.delete(id);
      resolve();
    };
    waiting.set(id, done);
    setTimeout(done, timeoutMs);
  });
}

/** Called when the host says a command finished. */
export function audioDone(id: number): void {
  waiting.get(id)?.();
}
