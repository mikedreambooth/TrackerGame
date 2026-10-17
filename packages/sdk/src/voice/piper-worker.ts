/**
 * Web Worker running Piper (neural text-to-speech, via ONNX Runtime in WASM)
 * so synthesis never blocks the camera/tracking loop on the main thread.
 *
 * Messages in:  { type: 'init', voiceId } | { type: 'speak', id, text }
 * Messages out: { type: 'progress', url, loaded, total } | { type: 'ready' }
 *               | { type: 'audio', id, wav: ArrayBuffer } | { type: 'error', id?, message }
 *
 * The voice model is downloaded once (from Hugging Face) and kept in the
 * browser's private storage (OPFS), so later loads are offline and instant.
 */
import * as tts from '@mintplex-labs/piper-tts-web';

type VoiceId = Parameters<typeof tts.predict>[0]['voiceId'];

const scope = self as unknown as {
  postMessage(msg: unknown, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent) => void) | null;
};

let voiceId = '' as VoiceId;

scope.onmessage = async (e: MessageEvent) => {
  const m = e.data as { type: 'init'; voiceId: string } | { type: 'speak'; id: number; text: string };
  try {
    if (m.type === 'init') {
      voiceId = m.voiceId as VoiceId;
      await tts.download(voiceId, (p: { url: string; loaded: number; total: number }) =>
        scope.postMessage({ type: 'progress', url: p.url, loaded: p.loaded, total: p.total }),
      );
      // Warm up: the first synthesis also loads the runtime and phonemizer.
      await tts.predict({ text: 'Ready.', voiceId });
      scope.postMessage({ type: 'ready' });
    } else if (m.type === 'speak') {
      const wav: Blob = await tts.predict({ text: m.text, voiceId });
      const buf = await wav.arrayBuffer();
      scope.postMessage({ type: 'audio', id: m.id, wav: buf }, [buf]);
    }
  } catch (err) {
    scope.postMessage({
      type: 'error',
      id: m.type === 'speak' ? m.id : undefined,
      message: (err as Error)?.message ?? String(err),
    });
  }
};
