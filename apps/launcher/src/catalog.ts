/** A game as described by its manifest.json plus server-side state. */
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
  enabled: boolean;
}

export async function fetchGames(): Promise<GameEntry[]> {
  const res = await fetch('/api/games');
  if (!res.ok) throw new Error(`catalog: HTTP ${res.status}`);
  const body = (await res.json()) as { games: GameEntry[] };
  return body.games;
}

export const gameUrl = (g: GameEntry) => `/games/${encodeURIComponent(g.id)}/index.html`;
export const iconUrl = (g: GameEntry) =>
  g.icon ? `/games/${encodeURIComponent(g.id)}/${encodeURIComponent(g.icon)}` : null;
