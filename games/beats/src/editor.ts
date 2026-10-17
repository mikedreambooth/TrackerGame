/**
 * Song Editor: a grown-up sets up a song's beat grid once — tap along, check
 * with clicks, nudge, save. Notes are then generated automatically in game.
 * Mouse/keyboard/touch page; not body-controlled.
 */
import { blip, unlockAudio } from '@trackergame/sdk';
import { analyzeUrl } from './detect';
import { FileMusic, YouTubeMusic, type Music } from './music';
import { deleteLocalSong, isLocalOverride, loadSongs, needsSetup, saveLocalSong, type Song } from './songs';
import { fitTaps } from './sync';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

// "Back" returns to wherever the editor was opened from (the PlayBox launcher), if it's this site.
{
  const back = new URLSearchParams(location.search).get('back');
  const link = $<HTMLAnchorElement>('back');
  try {
    if (back && new URL(back).origin === location.origin) link.href = back;
  } catch {
    /* keep the default */
  }
}
unlockAudio();

let songs: Song[] = [];
let song: Song | null = null;
let music: Music | null = null;
let taps: number[] = [];
/** The tempo before the current run of taps started (a later run only fine-tunes the phase). */
let runBpm: number | undefined;
let clicks = false;
let lastBeat = -Infinity;

function status(msg: string) {
  $('status').textContent = msg;
}

const fmt = (t: number) => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, '0')}`;

async function refresh(selectId?: string) {
  songs = await loadSongs();
  const list = $('list');
  list.replaceChildren(
    ...songs.map((s) => {
      const b = document.createElement('button');
      b.className = s.id === (selectId ?? song?.id) ? 'sel' : '';
      const tags = [s.source.type === 'youtube' ? 'YouTube' : 'audio file', needsSetup(s) ? '⚙ needs setup' : s.bpm ? `${s.bpm} BPM` : 'auto', isLocalOverride(s.id) ? 'edited here' : ''];
      b.innerHTML = `${escapeHtml(s.title)}<br><span class="tag">${tags.filter(Boolean).join(' · ')}</span>`;
      b.onclick = () => void select(s);
      return b;
    }),
  );
  if (selectId) {
    const s = songs.find((x) => x.id === selectId);
    if (s) await select(s);
  }
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

async function select(s: Song) {
  music?.destroy();
  music = null;
  song = { ...s };
  taps = [];
  runBpm = undefined;
  $('edit').hidden = false;
  [...$('list').children].forEach((b, i) => (b.className = songs[i]?.id === s.id ? 'sel' : ''));
  $<HTMLInputElement>('title').value = s.title;
  $('srcTag').textContent = s.source.type === 'youtube' ? `YouTube ${s.source.videoId}` : s.source.url;
  $('detect').hidden = s.source.type !== 'file';
  $('fileNote').hidden = s.source.type !== 'file';
  $('player').classList.toggle('audio', s.source.type === 'file');
  $('edit').scrollIntoView({ block: 'start', behavior: 'smooth' });
  $('play').textContent = '▶ Play';
  showGrid();
  status('Loading…');
  const host = $('player');
  if (s.source.type === 'youtube') {
    const box = document.createElement('div');
    host.querySelectorAll(':scope > div:not(#fileNote)').forEach((d) => d.remove());
    host.append(box);
    music = new YouTubeMusic(s.source.videoId, box, true);
  } else {
    host.querySelectorAll(':scope > div:not(#fileNote)').forEach((d) => d.remove());
    music = new FileMusic(new URL(s.source.url, document.baseURI).href);
  }
  const m = music;
  await m.load();
  if (music !== m) return;
  status(m.state === 'error' ? `⚠ ${m.error}` : needsSetup(song) ? 'Press Play, then tap along to the beat.' : '');
}

function showGrid() {
  if (!song) return;
  $<HTMLInputElement>('bpm').value = song.bpm ? String(song.bpm) : '';
  $('offset').textContent = song.offset !== undefined ? `${song.offset.toFixed(3)} s` : '–';
  $('startTxt').textContent = song.start ? `from ${fmt(song.start)}` : 'from the beginning';
  $('endTxt').textContent = song.end ? `to ${fmt(song.end)}` : 'to the end';
}

/** Keep the offset as the first beat at or after 0 (tidy JSON). */
function normalise() {
  if (!song?.bpm || song.offset === undefined) return;
  const beat = 60 / song.bpm;
  song.offset = Math.round((((song.offset % beat) + beat) % beat) * 1000) / 1000;
}

// ---------- transport ----------

$('play').onclick = () => {
  if (!music) return;
  if (music.state === 'playing' || music.state === 'waiting' || music.state === 'blocked') {
    music.pause();
  } else {
    music.play(music.time());
  }
};
const seek = (to: (t: number) => number) => {
  if (!music) return;
  const t = Math.max(0, to(music.time()));
  const wasPlaying = music.state === 'playing' || music.state === 'waiting';
  music.play(t);
  if (!wasPlaying) music.pause();
  taps = [];
};
$('back10').onclick = () => seek((t) => t - 10);
$('fwd10').onclick = () => seek((t) => t + 10);
$('later').onclick = () => seek(() => (music?.duration || 120) * 0.75);

// ---------- tapping ----------

function tap() {
  if (!music || !song || music.state !== 'playing') {
    status('Press Play first (and wait for the song to start).');
    return;
  }
  const t = music.time();
  if (!taps.length || t - taps[taps.length - 1] > 2.5) {
    taps = []; // a new run of taps
    runBpm = song.bpm;
  }
  taps.push(t);
  if (taps.length < 6) {
    $('tapInfo').textContent = `${taps.length} taps… keep going`;
    return;
  }
  const fit = fitTaps(taps);
  if (!fit) return;
  // Songs are almost always a whole number of BPM; snapping stops slow drift over the song.
  const whole = Math.round(fit.bpm);
  const bpm = Math.abs(fit.bpm - whole) < 0.4 ? whole : Math.round(fit.bpm * 10) / 10;
  // With an existing tempo, a later run of taps only fine-tunes the phase.
  const keepTempo = runBpm !== undefined && Math.abs(runBpm - bpm) < 1.5;
  const useBpm = keepTempo ? runBpm! : bpm;
  const phase = fitTaps(taps, useBpm)!;
  song.bpm = useBpm;
  song.offset = phase.offset;
  normalise();
  showGrid();
  const q = phase.quality;
  $('tapInfo').textContent = `${taps.length} taps · ${useBpm} BPM${keepTempo ? ' (kept)' : ` (measured ${fit.bpm})`} · steadiness ${(q * 100).toFixed(0)}%${q < 0.8 ? ' — a bit wobbly, keep tapping' : ' ✓'}`;
}
$('tap').addEventListener('pointerdown', (e) => {
  e.preventDefault();
  tap();
});
window.addEventListener('keydown', (e) => {
  if ((e.target as HTMLElement).matches('input, textarea')) return;
  if (e.code === 'Space') {
    e.preventDefault();
    if (!e.repeat) tap();
  }
});

// ---------- checking ----------

$('clicks').onclick = () => {
  clicks = !clicks;
  $('clicks').textContent = clicks ? '🔊 Clicks: on' : '🔈 Clicks: off';
};
$<HTMLInputElement>('bpm').onchange = () => {
  if (!song) return;
  const v = parseFloat($<HTMLInputElement>('bpm').value);
  if (v >= 40 && v <= 250) {
    song.bpm = v;
    song.offset ??= 0;
  }
  showGrid();
};
document.querySelectorAll<HTMLButtonElement>('[data-bpm]').forEach((b) => {
  b.onclick = () => {
    if (!song?.bpm) return;
    const d = b.dataset.bpm!;
    song.bpm = Math.round((d === 'half' ? song.bpm / 2 : d === 'double' ? song.bpm * 2 : song.bpm + parseFloat(d)) * 100) / 100;
    normalise();
    showGrid();
  };
});
document.querySelectorAll<HTMLButtonElement>('[data-off]').forEach((b) => {
  b.onclick = () => {
    if (!song?.bpm) return;
    song.offset = (song.offset ?? 0) + parseFloat(b.dataset.off!);
    normalise();
    showGrid();
  };
});
$('detect').onclick = async () => {
  if (song?.source.type !== 'file') return;
  status('Listening for the beat…');
  try {
    const info = await analyzeUrl(new URL(song.source.url, document.baseURI).href);
    song.bpm = info.bpm;
    song.offset = info.offset;
    normalise();
    showGrid();
    status(`Detected ${info.bpm} BPM (confidence ${(info.confidence * 100).toFixed(0)}%). Check with clicks.`);
  } catch (e) {
    status(`⚠ Couldn't analyse the audio: ${(e as Error).message}`);
  }
};

// ---------- range ----------

$('setStart').onclick = () => {
  if (song && music) song.start = Math.round(music.time() * 10) / 10;
  showGrid();
};
$('setEnd').onclick = () => {
  if (song && music) song.end = Math.round(music.time() * 10) / 10;
  showGrid();
};
$('clearRange').onclick = () => {
  if (!song) return;
  delete song.start;
  delete song.end;
  showGrid();
};

// ---------- saving ----------

function current(): Song | null {
  if (!song) return null;
  song.title = $<HTMLInputElement>('title').value.trim() || song.title;
  return song;
}
$('save').onclick = async () => {
  const s = current();
  if (!s) return;
  saveLocalSong(s);
  status(`Saved "${s.title}" on this device.`);
  await refresh();
};
$('copy').onclick = async () => {
  const s = current();
  if (!s) return;
  const json = JSON.stringify(s, null, 2);
  $<HTMLTextAreaElement>('importBox').value = json;
  try {
    await navigator.clipboard.writeText(json);
    status('Copied. (Also shown in the Import box.)');
  } catch {
    status('Copy it from the Import box on the left.');
  }
};
$('reset').onclick = async () => {
  if (!song) return;
  deleteLocalSong(song.id);
  status('Removed changes made on this device.');
  const id = song.id;
  song = null;
  await refresh(id);
};

// ---------- adding ----------

export function youtubeId(input: string): string | null {
  const s = input.trim();
  if (/^[\w-]{11}$/.test(s)) return s;
  try {
    const u = new URL(s);
    if (u.hostname.endsWith('youtu.be')) return u.pathname.slice(1, 12) || null;
    const v = u.searchParams.get('v');
    if (v) return v.slice(0, 11);
    const m = u.pathname.match(/\/(?:embed|shorts|live|v)\/([\w-]{11})/);
    return m?.[1] ?? null;
  } catch {
    return null;
  }
}
$('ytAdd').onclick = async () => {
  const id = youtubeId($<HTMLInputElement>('ytUrl').value);
  if (!id) {
    status("⚠ That doesn't look like a YouTube link.");
    return;
  }
  const s: Song = { id: `yt-${id}`, title: $<HTMLInputElement>('ytTitle').value.trim() || 'New song', source: { type: 'youtube', videoId: id } };
  saveLocalSong(s);
  $<HTMLInputElement>('ytUrl').value = '';
  $<HTMLInputElement>('ytTitle').value = '';
  await refresh(s.id);
  status('Added. Press Play, then tap along to the beat.');
};
$('importBtn').onclick = async () => {
  try {
    const s = JSON.parse($<HTMLTextAreaElement>('importBox').value) as Song;
    if (!s.id || !s.title || !s.source) throw new Error('missing id/title/source');
    saveLocalSong(s);
    await refresh(s.id);
    status(`Imported "${s.title}".`);
  } catch (e) {
    status(`⚠ Couldn't import: ${(e as Error).message}`);
  }
};

// ---------- clock, beat lights and clicks ----------

function frame() {
  if (music && song) {
    const t = music.time();
    $('clock').textContent = `${fmt(t)} ${music.state === 'waiting' ? '(waiting…)' : music.state === 'blocked' ? '(tap the video to start it)' : ''}`;
    const going = music.state === 'playing' || music.state === 'waiting' || music.state === 'blocked';
    const label = going ? '⏸ Pause' : '▶ Play';
    if ($('play').textContent !== label) $('play').textContent = label;
    if (song.bpm && song.offset !== undefined) {
      const beat = 60 / song.bpm;
      const n = Math.floor((t - song.offset) / beat);
      const playing = music.state === 'playing';
      if (n !== lastBeat) {
        if (playing && clicks && n === lastBeat + 1) blip(n % 4 === 0 ? 1500 : 1000, 40, 'square', 0.15);
        lastBeat = n;
      }
      const dots = $('dots').children;
      for (let i = 0; i < dots.length; i++) dots[i].className = playing && ((n % 4) + 4) % 4 === i ? 'beat on' : 'beat';
    }
  }
  requestAnimationFrame(frame);
}

const want = new URLSearchParams(location.search).get('song') ?? undefined;
await refresh(want);
requestAnimationFrame(frame);
