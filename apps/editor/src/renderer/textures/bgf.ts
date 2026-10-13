// Copied from meridian-browser packages/formats/src/bgf.ts (GPL-2.0, same authors),
// for the editor's texture browser. Keep the two in step.
//
// .bgf bitmap groups: sprites, wall/floor textures and icons
// (clientd3d/dibutil.c, makebgf/writebgf.c).
//
//   "BGF\x11" | i32 version (>= 10) | char name[32] | i32 numBitmaps | i32 numGroups |
//   i32 maxIndices | i32 shrink
//   per bitmap: i32 w, h, xoff, yoff | u8 nHotspots | n x (i8 number, i32 x, i32 y) |
//               u8 compressed | i32 length | zlib data (compressed) or w*h raw bytes
//   per group:  i32 n | n x i32 bitmap index
//
// Pixels are 8-bit palette indices; index 254 is transparent. Wall/floor textures
// (grd*.bgf) are stored transposed; the client's texture coordinates already account
// for that, so we keep the pixels exactly as stored.

export const TRANSPARENT_INDEX = 254;

export interface BgfBitmap {
  width: number;
  height: number;
  xOffset: number;
  yOffset: number;
  hotspots: { number: number; x: number; y: number }[];
  /** width * height palette indices, row-major as stored. */
  pixels: Uint8Array;
}

export interface Bgf {
  name: string;
  version: number;
  /** Texels per Kod fine unit, as the client uses it ("shrink factor"); never 0. */
  shrink: number;
  bitmaps: BgfBitmap[];
  /** Each group is a list of bitmap indices (0-based). */
  groups: number[][];
}

export type Inflate = (data: Uint8Array) => Promise<Uint8Array>;

/** zlib (RFC 1950) inflate with the platform DecompressionStream (browsers and Node 18+). */
export const inflateZlib: Inflate = async (data) => {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
};

export async function parseBgf(data: Uint8Array, inflate: Inflate = inflateZlib): Promise<Bgf> {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (data[0] !== 0x42 || data[1] !== 0x47 || data[2] !== 0x46 || data[3] !== 0x11) throw new Error("not a .bgf file");
  let p = 4;
  const i32 = () => {
    const v = dv.getInt32(p, true);
    p += 4;
    return v;
  };
  const version = i32();
  if (version < 10) throw new Error(`.bgf version ${version} unsupported`);
  let name = "";
  for (let i = 0; i < 32 && data[p + i]; i++) name += String.fromCharCode(data[p + i]);
  p += 32;
  const numBitmaps = i32();
  const numGroups = i32();
  i32(); // max indices
  const shrink = i32() & 0xff || 1; // (BYTE) cast in the client, 0 -> 1

  const bitmaps: BgfBitmap[] = [];
  const pending: Promise<void>[] = [];
  for (let i = 0; i < numBitmaps; i++) {
    const width = i32(),
      height = i32(),
      xOffset = i32(),
      yOffset = i32();
    const nh = data[p++];
    const hotspots = [];
    for (let j = 0; j < nh; j++) {
      const number = dv.getInt8(p);
      p += 1;
      hotspots.push({ number, x: i32(), y: i32() });
    }
    const compressed = data[p++];
    const len = i32();
    const bmp: BgfBitmap = { width, height, xOffset, yOffset, hotspots, pixels: new Uint8Array(0) };
    if (compressed === 1) {
      const chunk = data.subarray(p, p + len);
      p += len;
      pending.push(
        inflate(chunk).then((px) => {
          bmp.pixels = px.length === width * height ? px : px.subarray(0, width * height);
        }),
      );
    } else if (compressed === 0) {
      bmp.pixels = data.slice(p, p + width * height);
      p += width * height;
    } else throw new Error(`bad .bgf compression byte ${compressed}`);
    bitmaps.push(bmp);
  }
  const groups: number[][] = [];
  for (let g = 0; g < numGroups; g++) {
    const n = i32();
    const idx: number[] = [];
    for (let k = 0; k < n; k++) idx.push(i32());
    groups.push(idx);
  }
  await Promise.all(pending);
  return { name, version, shrink, bitmaps, groups };
}

/** Texture file name the client uses for a grid (wall/floor) texture number (GetGridPdib). */
export const gridTextureName = (id: number): string => `grd${String(id).padStart(5, "0")}.bgf`;
