/** Jousting artwork (Gemini, see art/generate.py). The knights and horses stay canvas paths. */
import { loadAssets } from '@trackergame/sdk';

const assets = await loadAssets({
  images: {
    background: 'art/background.jpg',
    barrier: 'art/barrier.png',
    crest: 'art/crest.png',
  },
});

export const art = assets.images;
