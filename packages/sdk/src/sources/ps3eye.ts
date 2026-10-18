/**
 * PlayStation Eye (PS3 Eye) driver over WebUSB, for Chrome/Edge on desktop.
 *
 * Windows has no working webcam driver for the PS3 Eye, but with the generic WinUSB
 * driver installed (Zadig, or the "PS3 Eye Universal" installer) the browser can talk
 * to it directly. This programs the OV534 bridge + OV7720 sensor, reads the raw Bayer
 * stream, converts it to colour on the GPU and exposes it as a normal MediaStream, so
 * everything downstream (MediaPipe, the debug view) just sees a 640x480@60 webcam.
 *
 * Register tables and stream format come from PS3EYEDriver (MIT, Thomas Perl / Eugene
 * Zatepyakin et al.), itself based on the Linux gspca ov534 driver.
 */

/** The `deviceId` used to pick the PS3 Eye (it isn't a normal media device). */
export const PS3EYE_ID = 'ps3eye-usb';
export const PS3EYE_LABEL = 'PlayStation Eye (USB)';

const VENDOR_ID = 0x1415;
const PRODUCT_ID = 0x2000;
const EP_IN = 1;
const PAYLOAD = 2048; // bytes per UVC-style payload, including its 12-byte header
const TRANSFER = 64 * PAYLOAD;
const IN_FLIGHT = 16;

// Minimal WebUSB typings (not in TypeScript's DOM lib).
interface USBDeviceLike {
  vendorId: number;
  productId: number;
  opened: boolean;
  configuration: unknown;
  open(): Promise<void>;
  close(): Promise<void>;
  selectConfiguration(n: number): Promise<void>;
  claimInterface(n: number): Promise<void>;
  releaseInterface(n: number): Promise<void>;
  controlTransferOut(setup: object, data: BufferSource): Promise<{ status: string }>;
  controlTransferIn(setup: object, length: number): Promise<{ status: string; data?: DataView }>;
  transferIn(ep: number, length: number): Promise<{ status: string; data?: DataView }>;
  clearHalt(direction: 'in' | 'out', ep: number): Promise<void>;
}
interface USBLike {
  getDevices(): Promise<USBDeviceLike[]>;
  requestDevice(opts: { filters: { vendorId: number; productId: number }[] }): Promise<USBDeviceLike>;
}
const usb = (): USBLike | undefined => (navigator as unknown as { usb?: USBLike }).usb;

const isEye = (d: USBDeviceLike) => d.vendorId === VENDOR_ID && d.productId === PRODUCT_ID;

/** True if this browser can drive a PS3 Eye at all (Chrome/Edge desktop). */
export function ps3EyeSupported(): boolean {
  return !!usb();
}

/** The PS3 Eye, if it's plugged in and this site has already been allowed to use it. */
export async function findPS3Eye(): Promise<USBDeviceLike | undefined> {
  return (await usb()?.getDevices())?.find(isEye);
}

/** Show the browser's USB picker. Must be called from a click/tap (user gesture). */
export async function requestPS3Eye(): Promise<boolean> {
  const u = usb();
  if (!u) return false;
  try {
    await u.requestDevice({ filters: [{ vendorId: VENDOR_ID, productId: PRODUCT_ID }] });
    return true;
  } catch {
    return false; // picker cancelled
  }
}

// ---------- register tables (reg, value) ----------

const OV534_REG_ADDRESS = 0xf1;
const OV534_REG_SUBADDR = 0xf2;
const OV534_REG_WRITE = 0xf3;
const OV534_REG_READ = 0xf4;
const OV534_REG_OPERATION = 0xf5;
const OV534_REG_STATUS = 0xf6;
const OV534_OP_WRITE_3 = 0x37;
const OV534_OP_WRITE_2 = 0x33;
const OV534_OP_READ_2 = 0xf9;

type Regs = [number, number][];

const BRIDGE_INIT: Regs = [
  [0xe7, 0x3a], [OV534_REG_ADDRESS, 0x42],
  [0x92, 0x01], [0x93, 0x18], [0x94, 0x10], [0x95, 0x10], [0xe2, 0x00], [0xe7, 0x3e],
  [0x96, 0x00], [0x97, 0x20], [0x97, 0x20], [0x97, 0x20], [0x97, 0x0a], [0x97, 0x3f],
  [0x97, 0x4a], [0x97, 0x20], [0x97, 0x15], [0x97, 0x0b],
  [0x8e, 0x40], [0x1f, 0x81], [0xc0, 0x50], [0xc1, 0x3c], [0xc2, 0x01], [0xc3, 0x01],
  [0x50, 0x89], [0x88, 0x08], [0x8d, 0x00], [0x8e, 0x00],
  [0x1c, 0x00], [0x1d, 0x00], [0x1d, 0x02], [0x1d, 0x00], [0x1d, 0x01], [0x1d, 0x2c], [0x1d, 0x00],
  [0x1c, 0x0a], [0x1d, 0x08], [0x1d, 0x0e],
  [0x34, 0x05], [0xe3, 0x04], [0x89, 0x00], [0x76, 0x00], [0xe7, 0x2e], [0x31, 0xf9],
  [0x25, 0x42], [0x21, 0xf0], [0xe5, 0x04],
];

const SENSOR_INIT: Regs = [
  [0x12, 0x80], [0x3d, 0x00], [0x12, 0x01], [0x11, 0x01], [0x14, 0x40], [0x15, 0x00],
  [0x63, 0xaa], [0x64, 0x87], [0x66, 0x00], [0x67, 0x02], [0x17, 0x26], [0x18, 0xa0],
  [0x19, 0x07], [0x1a, 0xf0], [0x29, 0xa0], [0x2a, 0x00], [0x2c, 0xf0], [0x20, 0x10],
  [0x4e, 0x0f], [0x3e, 0xf3], [0x0d, 0x41], [0x32, 0x00], [0x13, 0xf0], [0x22, 0x7f],
  [0x23, 0x03], [0x24, 0x40], [0x25, 0x30], [0x26, 0xa1], [0x2a, 0x00], [0x2b, 0x00],
  [0x13, 0xf7], [0x0c, 0xc0], [0x11, 0x00], [0x0d, 0x41], [0x8e, 0x00],
];

const BRIDGE_START_VGA: Regs = [
  [0x1c, 0x00], [0x1d, 0x00], [0x1d, 0x02], [0x1d, 0x00], [0x1d, 0x01], [0x1d, 0x2c],
  [0x1d, 0x00], [0xc0, 0x50], [0xc1, 0x3c],
];
const SENSOR_START_VGA: Regs = [
  [0x12, 0x01], [0x17, 0x26], [0x18, 0xa0], [0x19, 0x07], [0x1a, 0xf0], [0x29, 0xa0],
  [0x2c, 0xf0], [0x65, 0x20],
];

/** 640x480 frame rates: [fps, sensor 0x11, sensor 0x0d, bridge 0xe5]. */
const RATES_VGA: [number, number, number, number][] = [
  [75, 0x01, 0x81, 0x02], [60, 0x00, 0x41, 0x04], [50, 0x01, 0x41, 0x02],
  [40, 0x02, 0xc1, 0x04], [30, 0x04, 0x81, 0x02], [25, 0x00, 0x01, 0x02],
  [20, 0x04, 0x41, 0x02], [15, 0x09, 0x81, 0x02],
];

// ---------- camera ----------

const W = 640;
const H = 480;
const FRAME_BYTES = W * H; // 8-bit Bayer

export interface PS3EyeCamera {
  stream: MediaStream;
  fps: number;
  /** Frames received whole / thrown away (short, corrupt), since start. */
  counts: { frames: number; dropped: number; bad: number; transfers: number; bytes: number };
  stop(): Promise<void>;
}

class Eye {
  constructor(private dev: USBDeviceLike) {}

  async reg(reg: number, val: number): Promise<void> {
    await this.dev.controlTransferOut(
      { requestType: 'vendor', recipient: 'device', request: 0x01, value: 0, index: reg },
      new Uint8Array([val]),
    );
  }

  async regRead(reg: number): Promise<number> {
    const r = await this.dev.controlTransferIn(
      { requestType: 'vendor', recipient: 'device', request: 0x01, value: 0, index: reg },
      1,
    );
    return r.data?.getUint8(0) ?? 0;
  }

  private async sccbOk(): Promise<boolean> {
    for (let i = 0; i < 5; i++) {
      const s = await this.regRead(OV534_REG_STATUS);
      if (s === 0x00) return true;
      if (s === 0x04) return false;
    }
    return false;
  }

  async sensor(reg: number, val: number): Promise<void> {
    await this.reg(OV534_REG_SUBADDR, reg);
    await this.reg(OV534_REG_WRITE, val);
    await this.reg(OV534_REG_OPERATION, OV534_OP_WRITE_3);
    await this.sccbOk();
  }

  async sensorRead(reg: number): Promise<number> {
    await this.reg(OV534_REG_SUBADDR, reg);
    await this.reg(OV534_REG_OPERATION, OV534_OP_WRITE_2);
    await this.sccbOk();
    await this.reg(OV534_REG_OPERATION, OV534_OP_READ_2);
    await this.sccbOk();
    return this.regRead(OV534_REG_READ);
  }

  async regs(list: Regs) {
    for (const [r, v] of list) await this.reg(r, v);
  }
  async sensors(list: Regs) {
    for (const [r, v] of list) await this.sensor(r, v);
  }

  async led(on: boolean) {
    await this.reg(0x21, (await this.regRead(0x21)) | 0x80);
    const d = await this.regRead(0x23);
    await this.reg(0x23, on ? d | 0x80 : d & ~0x80);
    if (!on) await this.reg(0x21, (await this.regRead(0x21)) & ~0x80);
  }

  /** Reset + program bridge and sensor, then start streaming 640x480 Bayer. */
  async start(fps: number): Promise<number> {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    await this.reg(0xe7, 0x3a);
    await this.reg(0xe0, 0x08); // reset bridge
    await sleep(100);
    await this.reg(OV534_REG_ADDRESS, 0x42);
    await this.sensor(0x12, 0x80); // reset sensor
    await sleep(10);
    await this.regs(BRIDGE_INIT);
    await this.sensors(SENSOR_INIT);
    await this.reg(0xe0, 0x09);

    await this.regs(BRIDGE_START_VGA);
    await this.sensors(SENSOR_START_VGA);
    const rate = RATES_VGA.find((r) => fps >= r[0]) ?? RATES_VGA[RATES_VGA.length - 1];
    await this.sensor(0x11, rate[1]);
    await this.sensor(0x0d, rate[2]);
    await this.reg(0xe5, rate[3]);

    // Auto gain/exposure + auto white balance: we can't expect players to tune a camera.
    await this.sensor(0x13, 0xf7);
    await this.sensor(0x64, (await this.sensorRead(0x64)) | 0x03);
    await this.sensor(0x63, 0xe0);
    // Unflipped orientation, like an ordinary webcam (the tracker does its own mirroring).
    await this.sensor(0x0c, ((await this.sensorRead(0x0c)) & ~0xc0) | 0x40 | 0x80);

    await this.led(true);
    await this.reg(0xe0, 0x00); // start stream
    return rate[0];
  }

  async stop() {
    await this.reg(0xe0, 0x09);
    await this.led(false);
  }
}

/**
 * Converts raw Bayer frames to colour on the GPU (bilinear demosaic in a shader), so the
 * main thread stays free for pose tracking. The sensor's pattern is GRBG:
 * even rows G R G R…, odd rows B G B G…
 */
function bayerRenderer(canvas: HTMLCanvasElement) {
  const gl = canvas.getContext('webgl2', { antialias: false, depth: false });
  if (!gl) throw new Error('WebGL2 is needed for the PlayStation Eye');
  const shader = (type: number, src: string) => {
    const sh = gl.createShader(type)!;
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh) ?? 'shader');
    return sh;
  };
  const prog = gl.createProgram()!;
  gl.attachShader(
    prog,
    shader(
      gl.VERTEX_SHADER,
      `#version 300 es
      void main() {
        vec2 p = vec2(gl_VertexID == 1 ? 3.0 : -1.0, gl_VertexID == 2 ? 3.0 : -1.0);
        gl_Position = vec4(p, 0.0, 1.0);
      }`,
    ),
  );
  gl.attachShader(
    prog,
    shader(
      gl.FRAGMENT_SHADER,
      `#version 300 es
      precision highp float;
      uniform sampler2D bayer;
      out vec4 color;
      float at(ivec2 p) {
        p = clamp(p, ivec2(0), ivec2(${W - 1}, ${H - 1}));
        return texelFetch(bayer, p, 0).r;
      }
      void main() {
        // Canvas y runs bottom-up; the sensor's rows run top-down.
        ivec2 p = ivec2(int(gl_FragCoord.x), ${H - 1} - int(gl_FragCoord.y));
        float c = at(p);
        float h = (at(p + ivec2(-1, 0)) + at(p + ivec2(1, 0))) * 0.5;
        float v = (at(p + ivec2(0, -1)) + at(p + ivec2(0, 1))) * 0.5;
        float cross = (h + v) * 0.5;
        float diag = (at(p + ivec2(-1, -1)) + at(p + ivec2(1, -1)) + at(p + ivec2(-1, 1)) + at(p + ivec2(1, 1))) * 0.25;
        bool evenRow = (p.y & 1) == 0;
        bool evenCol = (p.x & 1) == 0;
        vec3 rgb;
        if (evenRow && evenCol) rgb = vec3(h, c, v);          // green on a red row
        else if (evenRow) rgb = vec3(c, cross, diag);         // red
        else if (evenCol) rgb = vec3(diag, cross, c);         // blue
        else rgb = vec3(v, c, h);                             // green on a blue row
        color = vec4(rgb, 1.0);
      }`,
    ),
  );
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) ?? 'link');
  gl.useProgram(prog);
  gl.bindVertexArray(gl.createVertexArray());

  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texStorage2D(gl.TEXTURE_2D, 1, gl.R8, W, H);
  gl.viewport(0, 0, W, H);

  return (frame: Uint8Array) => {
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, W, H, gl.RED, gl.UNSIGNED_BYTE, frame);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  };
}

/** Open the (already permitted) PS3 Eye and stream it as a MediaStream. */
export async function openPS3Eye(fps = 60): Promise<PS3EyeCamera> {
  const dev = await findPS3Eye();
  if (!dev) throw new Error('PlayStation Eye not found (plugged in, and allowed on the debug page?)');
  if (!dev.opened) await dev.open();
  if (dev.configuration === null) await dev.selectConfiguration(1);
  await dev.claimInterface(0);
  await dev.clearHalt('in', EP_IN).catch(() => {});

  const eye = new Eye(dev);
  const actualFps = await eye.start(fps);

  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const render = bayerRenderer(canvas);
  const stream = canvas.captureStream(actualFps);

  // Frame assembly: each 2048-byte payload has a 12-byte UVC-style header. A new frame
  // starts when the frame id or timestamp changes; it ends at EOF with exactly W*H bytes.
  // Double-buffered: `frame` fills from USB while `ready` waits to be drawn.
  let frame = new Uint8Array(FRAME_BYTES);
  let ready = new Uint8Array(FRAME_BYTES);
  let len = 0;
  let collecting = false;
  let lastPts = -1;
  let lastFid = -1;
  let pending = false;
  const counts = { frames: 0, dropped: 0, bad: 0, transfers: 0, bytes: 0 };

  const present = () => {
    pending = false;
    render(ready);
  };

  const scan = (data: DataView) => {
    for (let off = 0; off < data.byteLength; off += PAYLOAD) {
      const n = Math.min(PAYLOAD, data.byteLength - off);
      const hdr = data.getUint8(off + 1);
      if (n < 12 || data.getUint8(off) !== 12 || hdr & 0x40 || !(hdr & 0x04)) {
        counts.bad++;
        collecting = false; // bad header / error / no timestamp: drop this frame
        continue;
      }
      const pts = data.getUint32(off + 2, true);
      const fid = hdr & 0x01;
      const body = new Uint8Array(data.buffer, data.byteOffset + off + 12, n - 12);
      if (pts !== lastPts || fid !== lastFid) {
        lastPts = pts;
        lastFid = fid;
        len = 0;
        collecting = true;
      }
      if (!collecting) continue;
      if (len + body.length > FRAME_BYTES) {
        collecting = false;
        continue;
      }
      frame.set(body, len);
      len += body.length;
      if (hdr & 0x02) {
        // EOF
        lastPts = -1;
        collecting = false;
        if (len !== FRAME_BYTES) counts.dropped++;
        else {
          counts.frames++;
          [frame, ready] = [ready, frame];
          // Draw on the next animation frame, so a slow tab drops frames instead of lagging.
          if (!pending) {
            pending = true;
            requestAnimationFrame(present);
          }
        }
      }
    }
  };

  let running = true;
  const pump = (async () => {
    const queue = Array.from({ length: IN_FLIGHT }, () => dev.transferIn(EP_IN, TRANSFER));
    while (running) {
      const r = await queue.shift()!.catch((e: Error) => ({ status: 'error', error: e, data: undefined }));
      if (!running) break;
      queue.push(dev.transferIn(EP_IN, TRANSFER));
      if (r.status === 'ok' && r.data) {
        counts.transfers++;
        counts.bytes += r.data.byteLength;
        scan(r.data);
      }
      else if (r.status === 'stall') await dev.clearHalt('in', EP_IN).catch(() => {});
      else if (r.status === 'error') {
        console.warn('[ps3eye] USB read failed', (r as { error?: Error }).error);
        running = false;
      }
    }
    await Promise.allSettled(queue);
  })();

  return {
    stream,
    fps: actualFps,
    counts,
    async stop() {
      running = false;
      stream.getTracks().forEach((t) => t.stop());
      await eye.stop().catch(() => {});
      // Closing cancels the reads still waiting on the endpoint, which ends the pump.
      await dev.releaseInterface(0).catch(() => {});
      await dev.close().catch(() => {});
      await pump.catch(() => {});
    },
  };
}
