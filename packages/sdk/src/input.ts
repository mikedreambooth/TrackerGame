import { MediaPipeSource, savedCamera } from './sources/mediapipe';
import { SimSource } from './sources/sim';
import { NATIVE_TRACKER_ID, WebSocketSource } from './sources/websocket';
import type { InputSource } from './types';

/** True when the page itself is served from this machine (the console, or dev). */
function servedLocally(): boolean {
  return ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
}

/** Is a native tracker answering at `url`? Quick check, gives up after `ms`. */
function trackerRunning(url: string, ms = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch {
      return resolve(false);
    }
    const done = (ok: boolean) => {
      clearTimeout(t);
      ws.onopen = ws.onerror = null;
      ws.close();
      resolve(ok);
    };
    const t = setTimeout(() => done(false), ms);
    ws.onopen = () => done(true);
    ws.onerror = () => done(false);
  });
}

/**
 * Pick an input source:
 *   ?input=camera            in-browser MediaPipe
 *   ?input=sim&players=3     mouse/keyboard simulator
 *   ?input=ws&ws=ws://host:8765   native tracker process (tracker/)
 *   &camera=<deviceId>  &model=full
 * With no ?input, the choice saved on the debug page wins; otherwise it's automatic:
 * a page served from this machine (the console) uses the native tracker if one is
 * running, everything else (the hosted site) uses MediaPipe. The hosted site never
 * probes localhost, so visitors don't get a local-network permission prompt.
 * Falls back to the simulator if the camera can't start, so dev never blocks.
 */
export async function createInputFromUrl(
  params = new URLSearchParams(location.search),
  onStatus?: (message: string) => void,
): Promise<{ source: InputSource; warning?: string }> {
  // 127.0.0.1, not localhost: the tracker listens on IPv4 only, and on Windows trying ::1
  // first costs ~2 s per connection attempt.
  const wsUrl = params.get('ws') ?? 'ws://127.0.0.1:8765';
  const saved = savedCamera();
  let kind = params.get('input') ?? (saved === NATIVE_TRACKER_ID ? 'ws' : saved ? 'camera' : 'auto');
  if (kind === 'auto') kind = servedLocally() && (await trackerRunning(wsUrl)) ? 'ws' : 'camera';
  const sim = () => new SimSource(Number(params.get('players') ?? 1));

  if (kind === 'sim') {
    const s = sim();
    await s.start();
    return { source: s };
  }

  try {
    const source =
      kind === 'ws'
        ? new WebSocketSource(wsUrl, onStatus)
        : new MediaPipeSource({
            deviceId: params.get('camera') ?? undefined,
            model: params.get('model') === 'full' ? 'full' : 'lite',
            onStatus,
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
