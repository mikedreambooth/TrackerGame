import type { GameEntry } from './catalog';

const list = document.getElementById('list')!;
const msg = document.getElementById('msg')!;
const file = document.getElementById('file') as HTMLInputElement;

/** Optional PIN: if the server was started with ADMIN_PIN, we ask once and remember it. */
function pin(): string {
  try {
    return localStorage.getItem('adminPin') ?? '';
  } catch {
    return '';
  }
}

async function api(path: string, init: RequestInit = {}): Promise<Response> {
  const res = await fetch(path, { ...init, headers: { ...(init.headers ?? {}), 'x-admin-pin': pin() } });
  if (res.status === 401) {
    const p = prompt('Admin PIN?') ?? '';
    try {
      localStorage.setItem('adminPin', p);
    } catch {
      /* storage unavailable — will ask again */
    }
    return api(path, init);
  }
  return res;
}

async function refresh() {
  const res = await api('/api/games');
  const { games } = (await res.json()) as { games: GameEntry[] };
  list.replaceChildren();
  if (!games.length) list.textContent = 'No games installed.';
  for (const g of games) {
    const row = document.createElement('div');
    row.className = 'game';
    const info = document.createElement('div');
    info.className = 'info';
    const b = document.createElement('b');
    b.textContent = g.title;
    const small = document.createElement('small');
    small.textContent = `${g.id}${g.version ? ' · v' + g.version : ''}${g.description ? ' · ' + g.description : ''}`;
    info.append(b, small);

    const sw = document.createElement('label');
    sw.className = 'switch';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = g.enabled;
    cb.onchange = async () => {
      await api(`/api/games/${encodeURIComponent(g.id)}/enabled`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: cb.checked }),
      });
      msg.textContent = `${g.title} ${cb.checked ? 'shown' : 'hidden'}`;
    };
    sw.append(cb, 'Visible');

    const del = document.createElement('button');
    del.className = 'danger';
    del.textContent = 'Remove';
    del.onclick = async () => {
      if (!confirm(`Remove "${g.title}" from the box?`)) return;
      await api(`/api/games/${encodeURIComponent(g.id)}`, { method: 'DELETE' });
      msg.textContent = `${g.title} removed`;
      refresh();
    };
    row.append(info, sw, del);
    list.append(row);
  }
}

document.getElementById('upload')!.onclick = async () => {
  const f = file.files?.[0];
  if (!f) return void (msg.textContent = 'Choose a .zip first');
  msg.textContent = 'Uploading…';
  const res = await api('/api/games', {
    method: 'POST',
    headers: { 'Content-Type': 'application/zip' },
    body: f,
  });
  const body = (await res.json()) as { ok?: boolean; id?: string; error?: string };
  msg.textContent = res.ok ? `Published ${body.id}` : `Failed: ${body.error}`;
  file.value = '';
  refresh();
};

refresh().catch((e) => (list.textContent = `Error: ${(e as Error).message}`));
