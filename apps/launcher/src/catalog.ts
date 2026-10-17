/**
 * A game as described by its manifest.json. The build (scripts/build.mjs)
 * collects every enabled game's manifest into games/catalog.json.
 */
export interface GameEntry {
  id: string;
  title: string;
  description?: string;
  players?: { min: number; max: number };
  /** File inside the game folder, e.g. "icon.svg". */
  icon?: string;
  /** Tile colour when there's no icon. */
  color?: string;
  version?: string;
  /** Set to false in manifest.json to hide a game without deleting it. */
  enabled?: boolean;
  order?: number;
}

/** All URLs are relative, so the site works at a domain root or under a sub-path. */
export async function fetchGames(): Promise<GameEntry[]> {
  const res = await fetch('games/catalog.json', { cache: 'no-cache' });
  if (!res.ok) throw new Error(`catalog: HTTP ${res.status}`);
  const body = (await res.json()) as { games: GameEntry[] };
  return body.games.filter((g) => g.enabled !== false);
}

export const gameUrl = (g: GameEntry) => `games/${encodeURIComponent(g.id)}/index.html`;
export const iconUrl = (g: GameEntry) =>
  g.icon ? `games/${encodeURIComponent(g.id)}/${encodeURIComponent(g.icon)}` : null;
