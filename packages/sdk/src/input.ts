import { SimSource } from './sources/sim';
import { WebSocketSource } from './sources/websocket';
import type { InputSource } from './types';

/**
 * Pick an input source. Tracking runs on the server: the native tracker (tracker/, `npm run
 * tracker`) reads the camera and sends poses over WebSocket. The browser does no tracking.
 *
 *   (default)                     the native tracker at ws://127.0.0.1:8765
 *   ?ws=ws://host:8765            a tracker elsewhere
 *   ?input=sim&players=3          mouse/keyboard simulator, for testing without a camera
 *
 * With the tracker not running yet, the page waits for it (and reconnects if it restarts),
 * reporting progress through onStatus.
 */
export async function createInputFromUrl(
  params = new URLSearchParams(location.search),
  onStatus?: (message: string) => void,
): Promise<{ source: InputSource; warning?: string }> {
  if (params.get('input') === 'sim') {
    const s = new SimSource(Number(params.get('players') ?? 1));
    await s.start();
    return { source: s };
  }
  // 127.0.0.1, not localhost: the tracker listens on IPv4 only, and on Windows trying ::1
  // first costs ~2 s per connection attempt.
  const source = new WebSocketSource(params.get('ws') ?? 'ws://127.0.0.1:8765', onStatus);
  await source.start();
  return { source };
}
