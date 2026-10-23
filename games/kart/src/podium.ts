/**
 * The podium after a race: numbered pixel blocks floating in space, with each player standing
 * on theirs as a card showing their camera cut-out (like Block Dash's cards; a glowing stick
 * figure without one), in finishing order: 1st in the middle, 2nd on its left, 3rd on its
 * right, 4th beyond. Confetti falls; the winner bounces.
 */
import { KP, type Cutout, type Keypoint, type Player, type Segmentation } from '@trackergame/sdk';
import * as THREE from '@trackergame/sdk/three';
import { digitTexture, rgb } from './pixel';

const v3 = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);

const CARD_H = 2.6;
const CARD_W = CARD_H * 0.625;
/** Card texture size (same aspect as the card). */
const TW = 160;
const TH = 256;
/** The card shows this much more than the player's standing height (room for raised arms). */
const WINDOW = 1.3;
const MIN_SCORE = 0.3;

/** x and height of each place's block (1st, 2nd, 3rd, 4th). */
const BLOCKS = [
  { x: 0, h: 2.4, base: '#f2c230', ink: '#7a4a00' },
  { x: -3.3, h: 1.7, base: '#c9d1dc', ink: '#3a4250' },
  { x: 3.3, h: 1.1, base: '#d0844a', ink: '#5a2a10' },
  { x: 6.6, h: 0.5, base: '#7b6fa0', ink: '#ffffff' },
];
const BLOCK_W = 3.1;

export interface PodiumEntry {
  slot: number;
  id: number;
  color: string;
  /** 1-based. */
  place: number;
}

interface Card {
  entry: PodiumEntry;
  canvas: HTMLCanvasElement;
  g: CanvasRenderingContext2D;
  tex: THREE.CanvasTexture;
  mesh: THREE.Mesh;
  /** Crop around the player in camera space (smoothed): standing height, feet, centre. */
  hs: number;
  floor: number;
  cx: number;
}

const STICK: [number, number][] = [
  [KP.leftShoulder, KP.rightShoulder], [KP.leftShoulder, KP.leftElbow], [KP.leftElbow, KP.leftWrist],
  [KP.rightShoulder, KP.rightElbow], [KP.rightElbow, KP.rightWrist], [KP.leftShoulder, KP.leftHip],
  [KP.rightShoulder, KP.rightHip], [KP.leftHip, KP.rightHip], [KP.leftHip, KP.leftKnee],
  [KP.leftKnee, KP.leftAnkle], [KP.rightHip, KP.rightKnee], [KP.rightKnee, KP.rightAnkle],
];

const CONFETTI = 160;

export class Podium {
  readonly group = new THREE.Group();
  readonly camera = new THREE.PerspectiveCamera(45, 16 / 9, 0.1, 500);
  private blocks: THREE.Mesh[] = [];
  private cards: Card[] = [];
  private confetti: THREE.InstancedMesh;
  private bits: { p: THREE.Vector3; v: THREE.Vector3; spin: THREE.Euler; w: number }[] = [];
  private shownAt = 0;

  constructor(
    scene: THREE.Scene,
    at: THREE.Vector3,
    private aspect: () => number,
  ) {
    this.group.position.copy(at);
    this.group.visible = false;
    scene.add(this.group);
    BLOCKS.forEach((b, i) => {
      const face = new THREE.MeshLambertMaterial({ map: digitTexture(String(i + 1), rgb(b.base), rgb(b.ink)) });
      const side = new THREE.MeshLambertMaterial({ color: new THREE.Color(b.base).multiplyScalar(0.75) });
      const top = new THREE.MeshLambertMaterial({ color: new THREE.Color(b.base) });
      // Faces: +x, -x, +y, -y, +z (front: the number), -z.
      const m = new THREE.Mesh(new THREE.BoxGeometry(BLOCK_W, b.h, BLOCK_W), [side, side, top, side, face, side]);
      m.position.set(b.x, b.h / 2, 0);
      this.group.add(m);
      this.blocks.push(m);
    });
    // Confetti: little squares in rainbow colours.
    this.confetti = new THREE.InstancedMesh(new THREE.PlaneGeometry(0.16, 0.16), new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }), CONFETTI);
    const hues = ['#ff3b5c', '#ff8c1a', '#ffd51a', '#4be04b', '#1ad4ff', '#3b6bff', '#9b4bff', '#ff4bd8'];
    for (let i = 0; i < CONFETTI; i++) {
      this.confetti.setColorAt(i, new THREE.Color(hues[i % hues.length]));
      this.bits.push({ p: v3(), v: v3(), spin: new THREE.Euler(), w: 1 + Math.random() * 5 });
      this.respawn(i, true);
    }
    this.group.add(this.confetti);
  }

  /** Put these players on the blocks (one card each) and start the show. */
  show(entries: PodiumEntry[]) {
    for (const c of this.cards) this.dropCard(c);
    this.cards = entries.map((e) => this.makeCard(e));
    const n = Math.max(1, Math.min(4, entries.length));
    this.blocks.forEach((b, i) => (b.visible = i < n));
    this.group.visible = true;
    this.shownAt = performance.now();
    for (let i = 0; i < CONFETTI; i++) this.respawn(i, true);
  }

  hide() {
    this.group.visible = false;
    for (const c of this.cards) this.dropCard(c);
    this.cards = [];
  }

  get visible() {
    return this.group.visible;
  }

  /** Where a place's card stands (world), for labels. */
  topOf(place: number, extra = 0): THREE.Vector3 {
    const b = BLOCKS[Math.min(3, place - 1)];
    return this.group.localToWorld(v3(b.x, b.h + CARD_H + extra, 0.4));
  }
  footOf(place: number): THREE.Vector3 {
    const b = BLOCKS[Math.min(3, place - 1)];
    return this.group.localToWorld(v3(b.x, -0.25, BLOCK_W / 2));
  }

  update(dt: number, now: number, players: Player[], seg: Segmentation | null, viewAspect: number) {
    if (!this.visible) return;
    const t = (now - this.shownAt) / 1000;
    for (const c of this.cards) {
      const b = BLOCKS[Math.min(3, c.entry.place - 1)];
      const p = players.find((q) => q.id === c.entry.id) ?? players.find((q) => q.slot === c.entry.slot);
      if (p) this.paint(c, p, seg, dt);
      // Pop up onto the block one by one (last place first), the winner bouncing.
      const delay = (4 - c.entry.place) * 0.35;
      const k = Math.min(1, Math.max(0, (t - delay) / 0.4));
      const bounce = c.entry.place === 1 ? Math.abs(Math.sin(t * 4)) * 0.35 * k : 0;
      c.mesh.position.set(b.x, b.h + bounce, 0.4);
      c.mesh.scale.setScalar(0.001 + k * (1 + (1 - k) * 0.3));
    }
    // Confetti.
    const m = new THREE.Object3D();
    for (let i = 0; i < CONFETTI; i++) {
      const bit = this.bits[i];
      bit.v.y = Math.max(bit.v.y - 3 * dt, -2.2);
      bit.p.addScaledVector(bit.v, dt);
      bit.p.x += Math.sin(now / 400 + i) * 0.4 * dt;
      bit.spin.x += bit.w * dt;
      bit.spin.y += bit.w * 0.7 * dt;
      if (bit.p.y < -4) this.respawn(i, false);
      m.position.copy(bit.p);
      m.rotation.copy(bit.spin);
      m.updateMatrix();
      this.confetti.setMatrixAt(i, m.matrix);
    }
    this.confetti.instanceMatrix.needsUpdate = true;
    // Camera: in front, framing the blocks in use.
    const n = Math.max(1, Math.min(4, this.cards.length));
    const left = n >= 2 ? -3.3 : 0;
    const right = n >= 4 ? 6.6 : n >= 3 ? 3.3 : 0;
    const cx = (left + right) / 2;
    const span = right - left + BLOCK_W + 2;
    // Far enough back that the blocks and players fill the middle of the screen, leaving the
    // top for the title and the bottom for the buttons.
    const dist = Math.max(14, (span / 2 / Math.tan((this.camera.fov * Math.PI) / 360) / viewAspect) * 1.6);
    this.camera.aspect = viewAspect;
    this.camera.updateProjectionMatrix();
    this.camera.position.copy(this.group.localToWorld(v3(cx + Math.sin(t * 0.3) * 0.6, 3.4, dist)));
    this.camera.lookAt(this.group.localToWorld(v3(cx, 2.2, 0)));
  }

  private respawn(i: number, anywhere: boolean) {
    const bit = this.bits[i];
    bit.p.set((Math.random() - 0.5) * 18, anywhere ? Math.random() * 10 - 2 : 7 + Math.random() * 3, (Math.random() - 0.5) * 6);
    bit.v.set((Math.random() - 0.5) * 0.6, -0.5 - Math.random(), 0);
  }

  private makeCard(entry: PodiumEntry): Card {
    const canvas = document.createElement('canvas');
    canvas.width = TW;
    canvas.height = TH;
    const g = canvas.getContext('2d')!;
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.generateMipmaps = false;
    tex.minFilter = THREE.LinearFilter;
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(CARD_W, CARD_H).translate(0, CARD_H / 2, 0),
      new THREE.MeshBasicMaterial({ map: tex, transparent: true, alphaTest: 0.03, side: THREE.DoubleSide }),
    );
    mesh.scale.setScalar(0.001);
    this.group.add(mesh);
    return { entry, canvas, g, tex, mesh, hs: 0, floor: 0, cx: 0.5 };
  }

  private dropCard(c: Card) {
    c.mesh.removeFromParent();
    c.mesh.geometry.dispose();
    (c.mesh.material as THREE.Material).dispose();
    c.tex.dispose();
  }

  /**
   * Paint the card: a window around the player in camera space, WINDOW × their standing
   * height tall with their feet at the bottom, mirrored like the screen. Their cut-out with a
   * glow in their colour, else a stick figure.
   */
  private paint(c: Card, p: Player, seg: Segmentation | null, dt: number) {
    const raw = p.raw ?? p;
    const k = raw.keypoints;
    const A = this.aspect();
    const torso = torsoOf(k, A);
    if (torso) c.hs = c.hs ? c.hs + (torso * 3.25 - c.hs) * Math.min(1, dt * 3) : torso * 3.25;
    if (!c.hs) c.hs = Math.max(0.3, raw.bbox.h);
    const ankles = [KP.leftAnkle, KP.rightAnkle].filter((i) => k[i].score >= MIN_SCORE).map((i) => k[i].y);
    const hipY = (k[KP.leftHip].y + k[KP.rightHip].y) / 2;
    const f = ankles.length ? Math.max(...ankles) : hipY + c.hs * 0.5;
    c.floor = c.floor ? c.floor + (f - c.floor) * Math.min(1, dt * 6) : f;
    c.cx += (raw.center.x - c.cx) * Math.min(1, dt * 12);

    const g = c.g;
    const wh = c.hs * WINDOW;
    const ww = (wh * (TW / TH)) / A;
    const left = c.cx - ww / 2;
    const top = c.floor + c.hs * 0.03 - wh;
    const X = (x: number) => ((x - left) / ww) * TW;
    const Y = (y: number) => ((y - top) / wh) * TH;
    g.clearRect(0, 0, TW, TH);
    const cut = cutoutFor(seg, p, A);
    if (cut) {
      const dx = cut.anchor ? raw.center.x - (1 - cut.anchor.x) : 0;
      const dy = cut.anchor ? raw.center.y - cut.anchor.y : 0;
      const xl = X(1 - cut.box.x1 + dx);
      const xr = X(1 - cut.box.x0 + dx);
      const yt = Y(cut.box.y0 + dy);
      const yb = Y(cut.box.y1 + dy);
      g.save();
      g.shadowColor = c.entry.color;
      g.shadowBlur = 10;
      g.translate(xr, yt); // un-mirrored picture -> mirrored, like the screen
      g.scale(-1, 1);
      g.drawImage(cut.image, 0, 0, xr - xl, yb - yt);
      g.restore();
    } else {
      const ok = (i: number) => k[i].score >= MIN_SCORE;
      const pt = (i: number) => [X(k[i].x), Y(k[i].y)] as const;
      const lw = TH * 0.055;
      g.lineCap = g.lineJoin = 'round';
      for (const [col, w, blur] of [[c.entry.color, lw, 14], ['#ffffff', lw * 0.38, 0]] as const) {
        g.strokeStyle = col;
        g.lineWidth = w;
        g.shadowColor = c.entry.color;
        g.shadowBlur = blur;
        g.beginPath();
        for (const [a, b] of STICK) {
          if (!ok(a) || !ok(b)) continue;
          g.moveTo(...pt(a));
          g.lineTo(...pt(b));
        }
        g.stroke();
      }
      if (ok(KP.nose)) {
        const [nx, ny] = pt(KP.nose);
        const rad = (c.hs / wh) * TH * 0.075;
        g.shadowBlur = 14;
        g.fillStyle = c.entry.color;
        g.beginPath();
        g.arc(nx, ny - rad * 0.3, rad, 0, Math.PI * 2);
        g.fill();
      }
      g.shadowBlur = 0;
    }
    c.tex.needsUpdate = true;
  }
}

function torsoOf(k: Keypoint[], aspect: number): number | null {
  const ok = (i: number) => k[i].score >= MIN_SCORE;
  if (!ok(KP.leftShoulder) || !ok(KP.rightShoulder) || !ok(KP.leftHip) || !ok(KP.rightHip)) return null;
  const sx = (k[KP.leftShoulder].x + k[KP.rightShoulder].x) / 2;
  const sy = (k[KP.leftShoulder].y + k[KP.rightShoulder].y) / 2;
  const hx = (k[KP.leftHip].x + k[KP.rightHip].x) / 2;
  const hy = (k[KP.leftHip].y + k[KP.rightHip].y) / 2;
  return Math.hypot((sx - hx) * aspect, sy - hy);
}

/** The cut-out that belongs to this player: by id from the tracker, else nearest torso. */
function cutoutFor(seg: Segmentation | null, p: Player, aspect: number): Cutout | null {
  if (!seg) return null;
  const byId = seg.people.find((c) => c.player === p.id);
  if (byId) return byId;
  const c0 = (p.raw ?? p).center;
  let best: Cutout | null = null;
  let bestD = 0.15;
  for (const c of seg.people) {
    if ((c.player ?? -1) >= 0 || !c.anchor) continue;
    const d = Math.hypot((1 - c.anchor.x - c0.x) * aspect, c.anchor.y - c0.y);
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  return best;
}
