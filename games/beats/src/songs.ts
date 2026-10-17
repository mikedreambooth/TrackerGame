/**
 * Song charts. Songs come from public/songs/songs.json (committed to the repo)
 * plus anything saved on this device by the Song Editor (localStorage), which
 * overrides a song with the same id.
 *
 * A chart needs either hand-placed `notes`, or a tempo (`bpm` + `offset`) from
 * which notes are generated. File songs without a tempo get it detected from
 * the audio automatically; YouTube songs need tapping along once in the editor.
 */

export type Lane = 'LH' | 'LL' | 'RH' | 'RL';
export type NoteKind = 'hit' | 'both' | 'duck';

export interface Note {
  /** Song time in seconds when it should be hit. */
  t: number;
  kind: NoteKind;
  /** For 'hit': L/R = which hand (in Normal), H/L = high or low. */
  lane?: Lane;
}

export type SongSource = { type: 'file'; url: string } | { type: 'youtube'; videoId: string };

export interface Song {
  id: string;
  title: string;
  artist?: string;
  source: SongSource;
  /** Licence credit, shown in game. */
  credit?: string;
  /** Beats per minute. */
  bpm?: number;
  /** Song time (s) of any beat — together with bpm this places the beat grid. */
  offset?: number;
  /** Play from / to (s). Handy to skip a long intro. */
  start?: number;
  end?: number;
  /** Hand-placed notes (from the editor's record mode). Overrides generated ones. */
  notes?: Note[];
}

export type Difficulty = 'easy' | 'normal';

const LOCAL_KEY = 'beats.songs';

function readLocal(): Record<string, Song> {
  try {
    return JSON.parse(localStorage.getItem(LOCAL_KEY) ?? '{}');
  } catch {
    return {};
  }
}

export function saveLocalSong(song: Song): void {
  const all = readLocal();
  all[song.id] = song;
  try {
    localStorage.setItem(LOCAL_KEY, JSON.stringify(all));
  } catch {
    /* storage unavailable */
  }
}

export function deleteLocalSong(id: string): void {
  const all = readLocal();
  delete all[id];
  try {
    localStorage.setItem(LOCAL_KEY, JSON.stringify(all));
  } catch {
    /* storage unavailable */
  }
}

export function isLocalOverride(id: string): boolean {
  return id in readLocal();
}

/** Repo songs merged with this device's edits/additions. */
export async function loadSongs(): Promise<Song[]> {
  let base: Song[] = [];
  try {
    const res = await fetch('songs/songs.json', { cache: 'no-cache' });
    base = ((await res.json()) as { songs: Song[] }).songs;
  } catch (e) {
    console.warn('[beats] could not load songs.json', e);
  }
  const local = readLocal();
  const merged = base.map((s) => local[s.id] ?? s);
  for (const s of Object.values(local)) if (!base.some((b) => b.id === s.id)) merged.push(s);
  return merged;
}

/** A YouTube song with no beat grid yet can't be played until it's set up in the editor. */
export function needsSetup(song: Song): boolean {
  return song.source.type === 'youtube' && song.offset === undefined && !song.notes?.length;
}

/** Deterministic little RNG so a song always gets the same pattern. */
function rng(seed: string) {
  let h = 2166136261;
  for (const c of seed) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return ((h ^= h >>> 16) >>> 0) / 4294967296;
  };
}

/** Phrases of four, picked in sequence: kid-friendly alternating patterns. */
const PHRASES: Lane[][] = [
  ['LH', 'RH', 'LH', 'RH'],
  ['LL', 'RL', 'LL', 'RL'],
  ['LH', 'LL', 'RH', 'RL'],
  ['RH', 'RL', 'LH', 'LL'],
  ['LH', 'RH', 'LL', 'RL'],
  ['RL', 'LL', 'RH', 'LH'],
];

/**
 * Notes for a song: its hand-placed notes, or generated on the beat grid.
 * Easy keeps notes at least 0.8 s apart, Normal 0.42 s; every 16th note is a
 * two-hands star; Normal adds an occasional duck bar.
 */
export function chartNotes(song: Song, duration: number, difficulty: Difficulty): Note[] {
  const from = song.start ?? 0;
  const to = Math.min(song.end ?? Infinity, duration) - 1.5;
  if (song.notes?.length) {
    const notes = song.notes.filter((n) => n.t >= from && n.t <= to);
    return difficulty === 'easy' ? thin(notes, 0.8) : notes;
  }
  if (!song.bpm) return [];
  const beat = 60 / song.bpm;
  let step = 1;
  const minGap = difficulty === 'easy' ? 0.8 : 0.42;
  while (beat * step < minGap) step *= 2;
  const interval = beat * step;
  const offset = song.offset ?? 0;
  // First grid beat at least 3 s in (time to get ready), aligned to the grid.
  const first = offset + Math.ceil((from + 3 - offset) / interval) * interval;
  const rand = rng(song.id + difficulty);
  const notes: Note[] = [];
  let phrase = PHRASES[0];
  let n = 0;
  let skipUntil = 0;
  for (let t = first; t <= to; t += interval, n++) {
    if (t < skipUntil) continue;
    if (n % 4 === 0) phrase = PHRASES[Math.floor(rand() * PHRASES.length)];
    if (n > 0 && n % 16 === 15) {
      notes.push({ t, kind: 'both' });
      continue;
    }
    if (difficulty === 'normal' && n > 0 && n % 40 === 39) {
      notes.push({ t, kind: 'duck' });
      skipUntil = t + 2 * interval; // room to stand back up
      continue;
    }
    notes.push({ t, kind: 'hit', lane: phrase[n % 4] });
  }
  return notes;
}

function thin(notes: Note[], gap: number): Note[] {
  const out: Note[] = [];
  for (const n of notes) if (!out.length || n.t - out[out.length - 1].t >= gap) out.push(n);
  return out;
}
