import type { AudioCommand } from './audio-relay';
import type { SimPointer } from './sources/sim';
import type { Frame } from './types';

/** Messages between the launcher (host) and a game running in its iframe. */
export type HostMessage =
  | { tg: 1; kind: 'frame'; frame: Frame }
  | { tg: 1; kind: 'init'; inputName: string }
  /** A relayed audio command (say, play) finished. */
  | { tg: 1; kind: 'audioDone'; id: number }
  /** A quick tap the launcher caught (over its simulator layer), in screen fractions. */
  | { tg: 1; kind: 'tap'; x: number; y: number };

export type GameMessage =
  | { tg: 1; kind: 'ready' }
  | { tg: 1; kind: 'exit' }
  | { tg: 1; kind: 'scores'; scores: Record<number, number> }
  /** Per-game settings for the launcher. */
  | { tg: 1; kind: 'config'; exitGesture?: boolean; passTouches?: boolean }
  /** Sound/speech for the launcher to play (see audio-relay.ts). */
  | { tg: 1; kind: 'audio'; cmd: AudioCommand }
  /** Forwarded input so the simulator still works while a game iframe has focus. */
  | ({ tg: 1; kind: 'pointer' } & SimPointer)
  | { tg: 1; kind: 'key'; code: string; down: boolean };

export function isHostMessage(d: unknown): d is HostMessage {
  return typeof d === 'object' && d !== null && (d as { tg?: number }).tg === 1 && 'kind' in d;
}
export const isGameMessage = isHostMessage as unknown as (d: unknown) => d is GameMessage;
