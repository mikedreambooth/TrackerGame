import type { AudioCommand } from './audio-relay';
import type { Layout } from './layout';
import type { SimPointer } from './sources/sim';
import type { Cutout, Frame } from './types';

/**
 * Who draws the people cut out of the camera picture while a game runs: the launcher over
 * the whole page ('overlay', the default), the game itself behind its menus ('game', see
 * game.drawPeople()) or nobody ('off', e.g. games with avatars).
 */
export type PeopleMode = 'overlay' | 'game' | 'off';

/** Messages between the launcher (host) and a game running in its iframe. */
export type HostMessage =
  | { tg: 1; kind: 'frame'; frame: Frame }
  | { tg: 1; kind: 'init'; inputName: string }
  /** A relayed audio command (say, play) finished. */
  | { tg: 1; kind: 'audioDone'; id: number }
  /** A quick tap the launcher caught (over its simulator layer), in screen fractions. */
  | { tg: 1; kind: 'tap'; x: number; y: number }
  /** The latest people cut-outs (images are ImageBitmaps the game now owns), sent while the game draws them. */
  | { tg: 1; kind: 'people'; people: Cutout[] }
  /** Whether the viewer wants people shown (G). */
  | { tg: 1; kind: 'peopleOn'; on: boolean };

export type GameMessage =
  | { tg: 1; kind: 'ready' }
  | { tg: 1; kind: 'exit' }
  | { tg: 1; kind: 'scores'; scores: Record<number, number> }
  /** Per-game settings for the launcher. */
  | { tg: 1; kind: 'config'; exitGesture?: boolean; passTouches?: boolean; feet?: boolean; layout?: Layout; people?: PeopleMode }
  /** Sound/speech for the launcher to play (see audio-relay.ts). */
  | { tg: 1; kind: 'audio'; cmd: AudioCommand }
  /** Forwarded input so the simulator still works while a game iframe has focus. */
  | ({ tg: 1; kind: 'pointer' } & SimPointer)
  | { tg: 1; kind: 'key'; code: string; down: boolean };

export function isHostMessage(d: unknown): d is HostMessage {
  return typeof d === 'object' && d !== null && (d as { tg?: number }).tg === 1 && 'kind' in d;
}
export const isGameMessage = isHostMessage as unknown as (d: unknown) => d is GameMessage;
