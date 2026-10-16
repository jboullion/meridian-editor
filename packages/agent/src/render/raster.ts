// A tiny software rasterizer and PNG encoder: enough to draw a room map for an
// agent to look at, with no native dependencies. RGB, no antialiasing.

import { crc32, deflateSync } from "node:zlib";

export type Rgb = readonly [number, number, number];

export class Raster {
  readonly data: Uint8Array;
  readonly width: number;
  readonly height: number;
  constructor(width: number, height: number, background: Rgb) {
    this.width = width;
    this.height = height;
    this.data = new Uint8Array(width * height * 3);
    for (let i = 0; i < width * height; i++) this.data.set(background, i * 3);
  }

  pixel(x: number, y: number, c: Rgb, alpha = 1): void {
    x = Math.round(x);
    y = Math.round(y);
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    const o = (y * this.width + x) * 3;
    if (alpha >= 1) {
      this.data[o] = c[0];
      this.data[o + 1] = c[1];
      this.data[o + 2] = c[2];
    } else {
      for (let k = 0; k < 3; k++) this.data[o + k] = Math.round(this.data[o + k]! * (1 - alpha) + c[k]! * alpha);
    }
  }

  rect(x0: number, y0: number, x1: number, y1: number, c: Rgb, alpha = 1): void {
    for (let y = Math.max(0, Math.round(y0)); y <= Math.min(this.height - 1, Math.round(y1)); y++) {
      for (let x = Math.max(0, Math.round(x0)); x <= Math.min(this.width - 1, Math.round(x1)); x++) this.pixel(x, y, c, alpha);
    }
  }

  /** Even-odd fill of one or more rings (each a flat [x0, y0, x1, y1, ...] list), sampled at pixel centres. */
  fillRings(rings: readonly ArrayLike<number>[], c: Rgb, alpha = 1): void {
    let minY = Infinity;
    let maxY = -Infinity;
    for (const r of rings) {
      for (let i = 1; i < r.length; i += 2) {
        minY = Math.min(minY, r[i]!);
        maxY = Math.max(maxY, r[i]!);
      }
    }
    const xs: number[] = [];
    for (let y = Math.max(0, Math.floor(minY)); y <= Math.min(this.height - 1, Math.ceil(maxY)); y++) {
      const sy = y + 0.5;
      xs.length = 0;
      for (const r of rings) {
        const n = r.length / 2;
        for (let i = 0, j = n - 1; i < n; j = i++) {
          const yi = r[i * 2 + 1]!;
          const yj = r[j * 2 + 1]!;
          if (yi > sy !== yj > sy) xs.push(r[i * 2]! + ((sy - yi) * (r[j * 2]! - r[i * 2]!)) / (yj - yi));
        }
      }
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        for (let x = Math.max(0, Math.ceil(xs[k]! - 0.5)); x <= Math.min(this.width - 1, Math.floor(xs[k + 1]! - 0.5)); x++) this.pixel(x, y, c, alpha);
      }
    }
  }

  line(x0: number, y0: number, x1: number, y1: number, c: Rgb, width = 1, dash = 0): void {
    const len = Math.hypot(x1 - x0, y1 - y0);
    const steps = Math.max(1, Math.ceil(len * 2));
    const r = (width - 1) / 2;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      if (dash && Math.floor((t * len) / dash) % 2 === 1) continue;
      const x = x0 + (x1 - x0) * t;
      const y = y0 + (y1 - y0) * t;
      if (r <= 0) this.pixel(x, y, c);
      else this.rect(x - r, y - r, x + r, y + r, c);
    }
  }

  /** Text in the built-in 5×7 font, with a dark outline so it reads on any fill. */
  text(s: string, x: number, y: number, c: Rgb, scale = 2, outline: Rgb | null = [0, 0, 0]): { width: number; height: number } {
    const w = s.length * 6 * scale - scale;
    const h = 7 * scale;
    const draw = (ox: number, oy: number, col: Rgb): void => {
      [...s].forEach((ch, n) => {
        const g = FONT[ch];
        if (!g) return;
        for (let row = 0; row < 7; row++) {
          for (let bit = 0; bit < 5; bit++) {
            if (!(g[row]! & (16 >> bit))) continue;
            this.rect(x + ox + (n * 6 + bit) * scale, y + oy + row * scale, x + ox + (n * 6 + bit) * scale + scale - 1, y + oy + row * scale + scale - 1, col);
          }
        }
      });
    };
    if (outline) for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [1, 1], [-1, 1], [1, -1]] as const) draw(dx, dy, outline);
    draw(0, 0, c);
    return { width: w, height: h };
  }

  png(): Uint8Array {
    const { width, height, data } = this;
    const raw = new Uint8Array((width * 3 + 1) * height);
    for (let y = 0; y < height; y++) raw.set(data.subarray(y * width * 3, (y + 1) * width * 3), y * (width * 3 + 1) + 1);
    const chunk = (type: string, body: Uint8Array): Uint8Array => {
      const out = new Uint8Array(12 + body.length);
      const dv = new DataView(out.buffer);
      dv.setUint32(0, body.length);
      out.set(new TextEncoder().encode(type), 4);
      out.set(body, 8);
      dv.setUint32(8 + body.length, crc32(out.subarray(4, 8 + body.length)));
      return out;
    };
    const ihdr = new Uint8Array(13);
    const dv = new DataView(ihdr.buffer);
    dv.setUint32(0, width);
    dv.setUint32(4, height);
    ihdr.set([8, 2, 0, 0, 0], 8);
    const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", new Uint8Array())];
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) {
      out.set(p, o);
      o += p.length;
    }
    return out;
  }
}

// 5×7 glyphs, one byte per row, high bit on the left.
const FONT: Record<string, number[]> = {
  "0": [0b01110, 0b10001, 0b10011, 0b10101, 0b11001, 0b10001, 0b01110],
  "1": [0b00100, 0b01100, 0b00100, 0b00100, 0b00100, 0b00100, 0b01110],
  "2": [0b01110, 0b10001, 0b00001, 0b00010, 0b00100, 0b01000, 0b11111],
  "3": [0b11110, 0b00001, 0b00001, 0b01110, 0b00001, 0b00001, 0b11110],
  "4": [0b00010, 0b00110, 0b01010, 0b10010, 0b11111, 0b00010, 0b00010],
  "5": [0b11111, 0b10000, 0b11110, 0b00001, 0b00001, 0b10001, 0b01110],
  "6": [0b00110, 0b01000, 0b10000, 0b11110, 0b10001, 0b10001, 0b01110],
  "7": [0b11111, 0b00001, 0b00010, 0b00100, 0b01000, 0b01000, 0b01000],
  "8": [0b01110, 0b10001, 0b10001, 0b01110, 0b10001, 0b10001, 0b01110],
  "9": [0b01110, 0b10001, 0b10001, 0b01111, 0b00001, 0b00010, 0b01100],
  "-": [0, 0, 0, 0b11111, 0, 0, 0],
  ",": [0, 0, 0, 0, 0, 0b00100, 0b01000],
  S: [0b01111, 0b10000, 0b10000, 0b01110, 0b00001, 0b00001, 0b11110],
  L: [0b10000, 0b10000, 0b10000, 0b10000, 0b10000, 0b10000, 0b11111],
  V: [0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b01010, 0b00100],
  T: [0b11111, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100],
  x: [0, 0, 0b10001, 0b01010, 0b00100, 0b01010, 0b10001],
  y: [0, 0, 0b10001, 0b10001, 0b01111, 0b00001, 0b01110],
};
