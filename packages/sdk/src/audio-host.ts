/** Launcher side of the audio relay: plays what embedded games ask for. */
import { playSound, preloadSound } from './assets';
import type { AudioCommand } from './audio-relay';
import { blip, noise, pianoNote } from './sound';
import { prepareSpeech, say, stopSpeaking } from './speech';

const playing = new Map<number, () => void>();

/** Run one command from a game. `done(id)` is called when a tracked command finishes. */
export function runAudioCommand(cmd: AudioCommand, done: (id: number) => void): void {
  switch (cmd.op) {
    case 'blip':
      return blip(cmd.freq, cmd.ms, cmd.type, cmd.volume, cmd.slideTo);
    case 'noise':
      return noise(cmd.ms, cmd.volume);
    case 'note':
      playing.set(cmd.id, pianoNote(cmd.midi, cmd.volume));
      return;
    case 'say':
      void say(cmd.text, cmd.opts).then(() => done(cmd.id));
      return;
    case 'stopSpeaking':
      return stopSpeaking();
    case 'prepare':
      return prepareSpeech(cmd.lines);
    case 'preload':
      void preloadSound(cmd.url).catch(() => {});
      return;
    case 'play':
      // Report the moment it starts, so rhythm games can sync to it.
      playing.set(cmd.id, playSound(cmd.url, cmd.opts, () => done(cmd.id)));
      return;
    case 'stop':
      playing.get(cmd.id)?.();
      playing.delete(cmd.id);
      return;
  }
}

/** Stop everything a game started (called when leaving a game). */
export function stopAllGameAudio(): void {
  for (const stop of playing.values()) stop();
  playing.clear();
  stopSpeaking();
}
