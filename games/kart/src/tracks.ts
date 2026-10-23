/**
 * The tracks: each is a closed curve (with its own shape, palette and set dressing) turned into
 * a strip of road with walls along both edges, floating in space.
 *
 * Karts live in track coordinates, so a Track mostly answers "where is distance s along me?"
 * (at(s)): the road's centre, its forward / left / up directions and how sharply it bends.
 */
import * as THREE from '@trackergame/sdk/three';
import { mixRgb, pixelTexture, retile, rgb, seeded, shade, type Rgb } from './pixel';

type V3 = THREE.Vector3;
const v3 = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const mod = (a: number, n: number) => ((a % n) + n) % n;
const wrapAngle = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
/** sign(v) |v|^p: squares off a circle (superellipse). */
const sq = (v: number, p: number) => Math.sign(v) * Math.abs(v) ** p;

export interface TrackPoint {
  /** Centre of the road surface. */
  p: V3;
  /** Forward (unit, follows the slope). */
  f: V3;
  /** Across to the left (unit, level). */
  l: V3;
  /** Up from the road surface (unit). */
  up: V3;
  /** Direction in the ground plane (forward = (sin yaw, 0, cos yaw)). */
  yaw: number;
  /** Signed curvature, rad per unit length; + = bending left. */
  k: number;
}

export interface TrackLook {
  road: THREE.Texture;
  under: THREE.Texture;
  /** Wall face: u runs from the top of the wall down, v along the track. */
  wall: THREE.Texture;
  rail: THREE.Texture;
  /** The start gantry's banner. */
  banner: THREE.Texture;
}

export interface TrackDef {
  id: string;
  name: string;
  /** A closed curve over t in [0, 2π). Travel is towards increasing t. */
  curve: (t: number) => V3;
  /** Where the start line is (t): pick somewhere fairly straight. */
  startT: number;
  width: number;
  wallH: number;
  /** Space colour behind it. */
  sky: string;
  /** Its button in the track picker. */
  card: string;
  /** Colours for the picker's little map, along the track (u: 0..1 along). */
  mapColor: (u: number) => string;
  look: () => TrackLook;
  /** Set dressing (towers, cacti...), added to the track's group. */
  decorate?: (t: Track) => void;
}

const SAMPLES = 2400;
const DEPTH = 0.35;

export class Track {
  readonly L: number;
  readonly half: number;
  readonly group = new THREE.Group();
  readonly thumb: HTMLCanvasElement;
  private readonly points: TrackPoint[];
  private readonly step: number;

  constructor(readonly def: TrackDef) {
    this.half = def.width / 2;
    // Sample the curve finely, then resample it evenly by distance, so s (distance along)
    // maps straight to a sample.
    const RAW = 24000;
    const raw = Array.from({ length: RAW }, (_, i) => def.curve(def.startT + (i / RAW) * Math.PI * 2));
    const cum = [0];
    for (let i = 1; i < RAW; i++) cum.push(cum[i - 1] + raw[i].distanceTo(raw[i - 1]));
    const L = cum[RAW - 1] + raw[RAW - 1].distanceTo(raw[0]);
    const step = L / SAMPLES;
    const pos: V3[] = [];
    let r = 0;
    for (let j = 0; j < SAMPLES; j++) {
      const s = j * step;
      while (r < RAW - 1 && cum[r + 1] < s) r++;
      const end = r + 1 < RAW ? cum[r + 1] : L;
      pos.push(raw[r].clone().lerp(raw[(r + 1) % RAW], (s - cum[r]) / (end - cum[r])));
    }
    this.points = pos.map((p, j) => {
      const f = pos[(j + 1) % SAMPLES].clone().sub(pos[(j - 1 + SAMPLES) % SAMPLES]).normalize();
      const yaw = Math.atan2(f.x, f.z);
      const l = v3(Math.cos(yaw), 0, -Math.sin(yaw));
      return { p, f, l, up: f.clone().cross(l).normalize(), yaw, k: 0 };
    });
    // Curvature over a few samples either side (smoother than neighbours alone).
    const w = 3;
    this.points.forEach((tp, j) => {
      const a = this.points[(j - w + SAMPLES) % SAMPLES].yaw;
      const b = this.points[(j + w) % SAMPLES].yaw;
      tp.k = wrapAngle(b - a) / (2 * w * step);
    });
    this.L = L;
    this.step = step;
    this.build();
    def.decorate?.(this);
    this.thumb = this.drawThumb();
  }

  /** The track at distance s along it (wraps), interpolated. */
  at(s: number): TrackPoint {
    const x = mod(s, this.L) / this.step;
    const i = Math.floor(x) % SAMPLES;
    const a = this.points[i];
    const b = this.points[(i + 1) % SAMPLES];
    const u = x - Math.floor(x);
    const f = a.f.clone().lerp(b.f, u).normalize();
    const l = a.l.clone().lerp(b.l, u).normalize();
    return { p: a.p.clone().lerp(b.p, u), f, l, up: f.clone().cross(l).normalize(), yaw: Math.atan2(f.x, f.z), k: a.k + (b.k - a.k) * u };
  }

  /** A point `side` (1 left, -1 right) at the edge (plus `out`), `up` above the road. */
  edge(side: number, up: number, out = 0) {
    return (tp: TrackPoint) => tp.p.clone().addScaledVector(tp.l, side * (this.half + out)).addScaledVector(tp.up, up);
  }

  /** A tile length close to `want` that fits the lap a whole number of times (no seam at the start). */
  tile(want: number) {
    return this.L / Math.max(1, Math.round(this.L / want));
  }

  /** A strip along the track from s0 to s1 between two edges; u runs from edge a to b, v along (1 every vTile). */
  ribbon(s0: number, s1: number, segs: number, a: (tp: TrackPoint) => V3, b: (tp: TrackPoint) => V3, vTile: number, mat: THREE.Material): THREE.Mesh {
    const pos: number[] = [];
    const uv: number[] = [];
    const idx: number[] = [];
    for (let i = 0; i <= segs; i++) {
      const s = s0 + ((s1 - s0) * i) / segs;
      const tp = this.at(s);
      const A = a(tp);
      const B = b(tp);
      pos.push(A.x, A.y, A.z, B.x, B.y, B.z);
      const v = (s - s0) / vTile;
      uv.push(0, v, 1, v);
      if (i < segs) idx.push(i * 2, i * 2 + 1, i * 2 + 2, i * 2 + 1, i * 2 + 3, i * 2 + 2);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    const m = new THREE.Mesh(g, mat);
    this.group.add(m);
    return m;
  }

  /** Place `o` at distance s, `side` of the centre (in road widths from the edge: see edge()), facing along the track. */
  place(o: THREE.Object3D, s: number, side: number, out: number, up = 0) {
    const tp = this.at(s);
    o.position.copy(this.edge(side, up, out)(tp));
    o.rotation.y = tp.yaw;
    this.group.add(o);
    return o;
  }

  private build() {
    const { def, L } = this;
    const look = def.look();
    const basic = (map: THREE.Texture) => new THREE.MeshBasicMaterial({ map, side: THREE.DoubleSide });
    this.ribbon(0, L, SAMPLES, this.edge(1, 0), this.edge(-1, 0), this.tile(def.width), basic(look.road));
    this.ribbon(0, L, SAMPLES, this.edge(1, -DEPTH), this.edge(-1, -DEPTH), this.tile(def.width / 2), basic(look.under));
    for (const side of [1, -1]) {
      this.ribbon(0, L, SAMPLES, this.edge(side, def.wallH), this.edge(side, -DEPTH), this.tile(3), basic(look.wall));
      this.ribbon(0, L, SAMPLES, this.edge(side, def.wallH, 0.15), this.edge(side, def.wallH, -0.15), this.tile(1.6), basic(look.rail));
    }
    // The start line, and a gantry over it.
    const checker = pixelTexture(14, 2, (x, y) => ((x + y) % 2 ? [20, 20, 30] : [250, 250, 250]));
    this.ribbon(-0.9, 0.9, 2, this.edge(1, 0.03), this.edge(-1, 0.03), 1.8, basic(checker));
    const tp = this.at(0);
    const g = new THREE.Group();
    g.position.copy(tp.p);
    g.rotation.y = tp.yaw;
    const postMat = new THREE.MeshLambertMaterial({ map: retile(look.wall, 1, 3) });
    for (const side of [1, -1]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.5, 6, 0.5), postMat);
      post.position.set(side * (this.half + 0.4), 3 - DEPTH, 0);
      g.add(post);
    }
    const banner = new THREE.Mesh(new THREE.BoxGeometry(def.width + 1.3, 1.1, 0.3), new THREE.MeshBasicMaterial({ map: look.banner }));
    banner.position.set(0, 5.6, 0);
    g.add(banner);
    this.group.add(g);
  }

  /** A little pixel map of the track for the picker: the road from above, the start line marked. */
  private drawThumb(): HTMLCanvasElement {
    const W = 72;
    const H = 44;
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    const g = c.getContext('2d')!;
    g.fillStyle = this.def.sky;
    g.fillRect(0, 0, W, H);
    const pts = this.points.map((tp) => tp.p);
    const xs = pts.map((p) => p.x);
    const zs = pts.map((p) => p.z);
    const [x0, x1, z0, z1] = [Math.min(...xs), Math.max(...xs), Math.min(...zs), Math.max(...zs)];
    const k = Math.min((W - 10) / (x1 - x0), (H - 10) / (z1 - z0));
    const X = (x: number) => W / 2 + (x - (x0 + x1) / 2) * k;
    const Y = (z: number) => H / 2 + (z - (z0 + z1) / 2) * k;
    // Lowest first, so a bridge is drawn over the road beneath it.
    const segs = pts.map((_, i) => i).filter((i) => i % 6 === 0);
    segs.sort((a, b) => pts[a].y - pts[b].y);
    g.lineCap = 'round';
    for (const [w, outline] of [[5, true], [3, false]] as const)
      for (const i of segs) {
        const a = pts[i];
        const b = pts[(i + 6) % SAMPLES];
        g.strokeStyle = outline ? '#ffffff' : this.def.mapColor(i / SAMPLES);
        g.lineWidth = w;
        g.beginPath();
        g.moveTo(X(a.x), Y(a.z));
        g.lineTo(X(b.x), Y(b.z));
        g.stroke();
      }
    const s = pts[0];
    g.fillStyle = '#000';
    g.fillRect(Math.round(X(s.x)) - 2, Math.round(Y(s.z)) - 2, 4, 4);
    g.fillStyle = '#fff';
    g.fillRect(Math.round(X(s.x)) - 2, Math.round(Y(s.z)) - 2, 2, 2);
    g.fillRect(Math.round(X(s.x)), Math.round(Y(s.z)), 2, 2);
    return c;
  }
}

// ---------- the tracks ----------

const RAINBOW = ['#ff3b5c', '#ff8c1a', '#ffd51a', '#4be04b', '#1ad4ff', '#3b6bff', '#9b4bff', '#ff4bd8'];
const lambert = (map: THREE.Texture) => new THREE.MeshLambertMaterial({ map });

const rainbow: TrackDef = {
  id: 'rainbow',
  name: 'Rainbow Road',
  // A figure-8 that rises and falls, so one pass crosses over the other on a bridge.
  curve: (t) => v3(85 * Math.sin(t), 5 * Math.cos(t), 36 * Math.sin(2 * t)),
  startT: 0.12 * Math.PI,
  width: 13,
  wallH: 1.2,
  sky: '#05030f',
  card: '#7b2ff7',
  mapColor: (u) => RAINBOW[Math.floor(u * 24) % 8],
  look: () => {
    const r = seeded(7);
    const bands = RAINBOW.map(rgb);
    const sparkles = new Set(Array.from({ length: 7 }, () => Math.floor(r() * 32) * 32 + Math.floor(r() * 32)));
    const glowA = rgb('#3ff5ff');
    const glowB = rgb('#ff5cf0');
    return {
      // Eight rainbow bands across, a darker seam now and then along it, a few sparkles.
      road: pixelTexture(32, 32, (x, y) => {
        if (sparkles.has(y * 32 + x)) return [255, 255, 255];
        let c = bands[Math.floor(x / 4)];
        if (x % 4 === 0) c = shade(c, 0.82);
        if (y % 16 === 0) c = shade(c, 0.55);
        else if (y % 16 === 1) c = mixRgb(c, [255, 255, 255], 0.35);
        return shade(c, 0.9 + r() * 0.12);
      }),
      under: pixelTexture(16, 16, () => (r() < 0.04 ? [220, 200, 255] : shade([40, 18, 80], 0.85 + r() * 0.3))),
      // A white rail, glowing blocks, a dark base.
      wall: pixelTexture(8, 16, (x, y) => {
        if (x <= 1) return shade([255, 255, 255], x === 1 ? 0.8 : 1);
        if (x >= 6) return shade([30, 14, 60], 0.9 + r() * 0.2);
        if (y % 8 === 0 || x === 5) return [20, 8, 40];
        const c = y < 8 ? glowA : glowB;
        return x === 2 ? mixRgb(c, [255, 255, 255], 0.5) : shade(c, 0.85 + r() * 0.15);
      }),
      rail: pixelTexture(2, 8, (_x, y) => (y < 4 ? [255, 214, 40] : [255, 255, 255])),
      banner: pixelTexture(14, 2, (x, y) => ((x + y) % 2 ? [20, 20, 30] : [250, 250, 250])),
    };
  },
};

// Castle: grey cobbles with a royal red carpet down the middle, battlements, towers with flags.
const STONE = rgb('#78748a');
const MORTAR = rgb('#46424f');
const CARPET = rgb('#aa1830');
const GOLD = rgb('#e6ba3c');
const PURPLE = rgb('#6e28a0');

const castleBricks = (w: number, h: number, rowH: number, brickW: number, base: Rgb, seed: number) => {
  const r = seeded(seed);
  const shadeOf = new Map<string, number>();
  return pixelTexture(w, h, (x, y) => {
    const row = Math.floor(x / rowH);
    const col = Math.floor((y + (row % 2) * (brickW / 2)) / brickW);
    if (x % rowH === rowH - 1 || (y + (row % 2) * (brickW / 2)) % brickW === brickW - 1) return MORTAR;
    const key = `${row},${col}`;
    if (!shadeOf.has(key)) shadeOf.set(key, 0.82 + r() * 0.3);
    return shade(base, shadeOf.get(key)! * (0.96 + r() * 0.06));
  });
};

const castle: TrackDef = {
  id: 'castle',
  name: 'Castle Keep',
  // A squared-off loop round the keep, with a kink at the gatehouse on the far side.
  curve: (t) => v3(80 * sq(Math.cos(t), 0.4), 3 * Math.sin(2 * t), 50 * sq(Math.sin(t), 0.4) + 16 * Math.exp(-((t - Math.PI * 1.5) ** 2) * 8)),
  startT: Math.PI / 2,
  width: 12,
  wallH: 1.5,
  sky: '#0b1030',
  card: '#4a4e69',
  mapColor: (u) => (Math.floor(u * 40) % 2 ? '#a7a3b8' : '#8a8699'),
  look: () => {
    const r = seeded(21);
    const stoneShade = new Map<string, number>();
    return {
      road: (() => {
        return pixelTexture(32, 32, (x, y) => {
          // Carpet: gold-trimmed, with a diamond pattern.
          if (x === 12 || x === 19) return GOLD;
          if (x > 12 && x < 19) {
            const d = Math.abs((y % 8) - 3.5) + Math.abs(x - 15.5);
            return d < 2.2 ? mixRgb(CARPET, GOLD, 0.55) : shade(CARPET, 0.92 + r() * 0.1);
          }
          // Cobbles in staggered rows.
          const row = Math.floor(y / 5);
          const off = (row % 2) * 3;
          if (y % 5 === 4 || (x + off) % 6 === 5) return MORTAR;
          const key = `${row},${Math.floor((x + off) / 6)}`;
          if (!stoneShade.has(key)) stoneShade.set(key, 0.8 + r() * 0.35);
          return shade(STONE, stoneShade.get(key)!);
        });
      })(),
      under: castleBricks(16, 16, 4, 8, shade(STONE, 0.5), 22),
      wall: castleBricks(16, 16, 4, 8, STONE, 23),
      rail: pixelTexture(2, 8, () => shade(STONE, 1.15)),
      banner: pixelTexture(14, 2, (x, y) => ((x + y) % 2 ? PURPLE : GOLD)),
    };
  },
  decorate: (t) => {
    const stoneMat = lambert(castleBricks(16, 16, 4, 8, STONE, 24));
    // Battlements along the tops of both walls.
    const gap = t.tile(2.4);
    const n = Math.round(t.L / gap);
    const merlons = new THREE.InstancedMesh(new THREE.BoxGeometry(0.7, 0.7, 1.0), stoneMat, n * 2);
    const m = new THREE.Object3D();
    let i = 0;
    for (const side of [1, -1])
      for (let j = 0; j < n; j++) {
        const tp = t.at(j * gap);
        m.position.copy(t.edge(side, t.def.wallH + 0.35)(tp));
        m.rotation.set(0, tp.yaw, 0);
        m.updateMatrix();
        merlons.setMatrixAt(i++, m.matrix);
      }
    t.group.add(merlons);
    // Towers on the outside of the bends, with pointed roofs and pennants.
    const towerMat = lambert(retile(castleBricks(16, 16, 4, 8, STONE, 25), 3, 3));
    const roofMat = lambert(
      pixelTexture(16, 16, (x, y) => (y % 4 === 3 || (x + (Math.floor(y / 4) % 2) * 2) % 4 === 3 ? [110, 20, 30] : [190, 50, 50])),
    );
    const flagMat = new THREE.MeshLambertMaterial({ map: pixelTexture(8, 4, (x) => (x < 2 ? GOLD : PURPLE)), side: THREE.DoubleSide });
    const poleMat = new THREE.MeshLambertMaterial({ color: 0x3a2a20 });
    const TOWERS = 8;
    for (let j = 0; j < TOWERS; j++) {
      const s = ((j + 0.5) * t.L) / TOWERS;
      const tp = t.at(s);
      const side = tp.k > 0 ? -1 : 1; // the outside of the bend
      const g = new THREE.Group();
      const body = new THREE.Mesh(new THREE.CylinderGeometry(2.4, 2.6, 12, 8), towerMat);
      body.position.y = -2;
      const roof = new THREE.Mesh(new THREE.ConeGeometry(3.1, 3.4, 8), roofMat);
      roof.position.y = 5.7;
      const pole = new THREE.Mesh(new THREE.BoxGeometry(0.12, 2.2, 0.12), poleMat);
      pole.position.y = 8.3;
      const flag = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 0.8), flagMat);
      flag.position.set(0, 8.9, 0.8);
      flag.rotation.y = Math.PI / 2;
      g.add(body, roof, pole, flag);
      t.place(g, s, side, 3.4);
    }
  },
};

// Desert: a sandy highway with terracotta edges, sandstone walls with a turquoise zig-zag,
// cacti on little floating sand islands, and pyramids drifting in the dusk.
const SAND = rgb('#e2b876');
const TERRACOTTA = rgb('#c46034');
const CREAM = rgb('#f6e2b4');
const TEAL = rgb('#28a096');
const SANDSTONE = rgb('#d89c60');

const desert: TrackDef = {
  id: 'desert',
  name: 'Dune Dash',
  // Three big lobes with S-bends between them, over rolling dunes.
  curve: (t) => {
    const r = 64 + 12 * Math.cos(3 * t);
    return v3(r * Math.cos(t), 2.5 * Math.sin(3 * t + 0.6), r * Math.sin(t));
  },
  startT: Math.PI / 6,
  width: 14,
  wallH: 1.0,
  sky: '#2a1238',
  card: '#c8743a',
  mapColor: () => '#e2b876',
  look: () => {
    const r = seeded(31);
    return {
      road: pixelTexture(32, 32, (x, y) => {
        if (x <= 1 || x >= 30) return shade(TERRACOTTA, x === 1 || x === 30 ? 0.9 : 1);
        if ((x === 15 || x === 16) && y % 16 < 9) return CREAM;
        if (x === 8 || x === 9 || x === 22 || x === 23) return shade(SAND, 0.86 + r() * 0.05); // wheel ruts
        if (r() < 0.02) return shade(SAND, 0.7); // pebbles
        return shade(SAND, 0.93 + r() * 0.1);
      }),
      under: pixelTexture(16, 16, () => shade([130, 74, 50], 0.85 + r() * 0.25)),
      wall: pixelTexture(8, 16, (x, y) => {
        if (x <= 1) return x === 0 ? CREAM : shade(CREAM, 0.9);
        if (x >= 6) return shade(SANDSTONE, 0.7 + r() * 0.08);
        // A zig-zag band.
        const zig = Math.abs((y % 8) - 4);
        if (x - 2 === Math.floor(zig / 1.4)) return TEAL;
        return shade(SANDSTONE, 0.95 + r() * 0.1);
      }),
      rail: pixelTexture(2, 8, (_x, y) => (y < 4 ? TERRACOTTA : CREAM)),
      banner: pixelTexture(14, 2, (x, y) => ((x + y) % 2 ? TERRACOTTA : CREAM)),
    };
  },
  decorate: (t) => {
    const r = seeded(33);
    const cactusMat = lambert(pixelTexture(8, 8, (x) => (x % 3 === 0 ? [40, 110, 50] : [76, 160, 70])));
    const islandMat = lambert(pixelTexture(8, 8, () => shade(SAND, 0.85 + r() * 0.2)));
    const CACTI = 14;
    for (let j = 0; j < CACTI; j++) {
      const g = new THREE.Group();
      const island = new THREE.Mesh(new THREE.BoxGeometry(3, 0.6, 3), islandMat);
      island.position.y = -0.3;
      const h = 2.6 + r() * 1.4;
      const trunk = new THREE.Mesh(new THREE.BoxGeometry(0.7, h, 0.7), cactusMat);
      trunk.position.y = h / 2;
      g.add(island, trunk);
      for (const side of [1, -1]) {
        if (r() < 0.25) continue;
        const ay = 0.9 + r() * (h - 1.8);
        const out = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.45, 0.45), cactusMat);
        out.position.set(side * 0.6, ay, 0);
        const up = new THREE.Mesh(new THREE.BoxGeometry(0.45, 1.1, 0.45), cactusMat);
        up.position.set(side * 0.85, ay + 0.55, 0);
        g.add(out, up);
      }
      const s = ((j + r() * 0.5) * t.L) / CACTI;
      t.place(g, s, j % 2 ? 1 : -1, 2.6, -0.2);
    }
    // Pyramids drifting further out.
    const stone = pixelTexture(16, 16, (x, y) => (y % 4 === 3 || (x + (Math.floor(y / 4) % 2) * 4) % 8 === 7 ? shade(SANDSTONE, 0.7) : shade(SANDSTONE, 0.95 + r() * 0.1)));
    const pyrMat = lambert(retile(stone, 4, 4));
    for (const [a, size] of [[0.3, 18], [2.4, 13], [4.3, 22]] as const) {
      const p = new THREE.Mesh(new THREE.ConeGeometry(size, size * 0.9, 4), pyrMat);
      p.position.set(Math.cos(a) * 118, -10 + size * 0.45, Math.sin(a) * 118);
      p.rotation.y = a;
      t.group.add(p);
    }
  },
};

export const TRACK_DEFS: TrackDef[] = [rainbow, castle, desert];
