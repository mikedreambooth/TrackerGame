/** Sports Day artwork (Gemini, see art/generate.py), loaded once for every event. */
import { loadAssets } from '@trackergame/sdk';

const assets = await loadAssets({
  images: {
    background: 'art/background.jpg',
    hurdle: 'art/hurdle.png',
    mat: 'art/mat.png',
    medal1: 'art/medal_gold.png',
    medal2: 'art/medal_silver.png',
    medal3: 'art/medal_bronze.png',
    podium: 'art/podium.png',
    trophy: 'art/trophy.png',
    star: 'art/star.png',
  },
});

export const art = assets.images;
