import { MediaPipeSource } from './sources/mediapipe';
import { SimSource } from './sources/sim';
import { WebSocketSource } from './sources/websocket';
import type { InputSource } from './types';

/**
 * Pick an input source from the URL:
 *   ?input=camera (default)  in-browser MediaPipe
 *   ?input=sim&players=3     mouse/keyboard simulator
 *   ?input=ws&ws=ws://host:8765   native tracker process
 *   &camera=<deviceId>  &model=full
 * Falls back to the simulator if the camera can't start, so dev never blocks.
 */
export async function createInputFromUrl(
  params = new URLSearchParams(location.search),
): Promise<{ source: InputSource; warning?: string }> {
  const kind = params.get('input') ?? 'camera';
  const sim = () => new SimSource(Number(params.get('players') ?? 1));

  if (kind === 'sim') {
    const s = sim();
    await s.start();
    return { source: s };
  }

  try {
    const source =
      kind === 'ws'
        ? new WebSocketSource(params.get('ws') ?? 'ws://localhost:8765')
        : new MediaPipeSource({
            deviceId: params.get('camera') ?? undefined,
            model: params.get('model') === 'full' ? 'full' : 'lite',
          });
    await source.start();
    return { source };
  } catch (err) {
    console.warn(`[input] ${kind} failed, falling back to simulator`, err);
    const s = sim();
    await s.start();
    return { source: s, warning: `${kind} input failed (${(err as Error).message}). Using simulator.` };
  }
}
