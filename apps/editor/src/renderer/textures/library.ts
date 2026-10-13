// The texture library: which texture numbers exist, and their pictures.
// Grid textures are stored transposed (walls are drawn in columns), so the
// thumbnails transpose them back; a texture's width in editor units is its
// stored height divided by its shrink (roomedit GetWallTextureSize).

import { useEffect, useState, useSyncExternalStore } from "react";
import paletteText from "../assets/blakston.pal?raw";
import { host } from "../host.ts";
import { editor, Store } from "../store.ts";
import { gridTextureName, parseBgf, TRANSPARENT_INDEX, type Bgf } from "./bgf.ts";

export interface TextureInfo {
  number: number;
  /** Display size in texels (upright). */
  width: number;
  height: number;
  shrink: number;
  /** An object URL of the first frame, upright. */
  url: string;
  frames: number;
}

interface LibraryState {
  dir: string;
  numbers: number[];
  loading: boolean;
  /** Bumped each time the library is (re)loaded, so views can refresh their textures. */
  version: number;
}

export const library = new Store<LibraryState>({ dir: "", numbers: [], loading: false, version: 0 });
export const useLibrary = <R,>(select: (s: LibraryState) => R): R => useSyncExternalStore(library.subscribe, () => select(library.get()));

const PALETTE: Uint8Array = (() => {
  const out = new Uint8Array(256 * 3);
  paletteText
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .slice(0, 256)
    .forEach((line, i) => {
      const [r, g, b] = line.trim().split(/\s+/).map(Number);
      out[i * 3] = Math.min(255, r ?? 0);
      out[i * 3 + 1] = Math.min(255, g ?? 0);
      out[i * 3 + 2] = Math.min(255, b ?? 0);
    });
  return out;
})();

const cache = new Map<number, Promise<TextureInfo | null>>();
const bgfCache = new Map<number, Promise<Bgf | null>>();

/** The parsed .bgf for a texture number, for the 3D preview; null if it isn't in the library. */
export function loadBgf(number: number): Promise<Bgf | null> {
  let p = bgfCache.get(number);
  if (!p) {
    p = knownSet.has(number) ? host.readTexture(gridTextureName(number)).then(parseBgf).catch(() => null) : Promise.resolve(null);
    bgfCache.set(number, p);
  }
  return p;
}

/** The palette as RGB triples, 256 entries. */
export function palette(): Uint8Array {
  return PALETTE;
}
let knownSet = new Set<number>();

export function knownTextures(): ReadonlySet<number> {
  return knownSet;
}

export async function reloadLibrary(): Promise<void> {
  library.set({ loading: true });
  for (const p of cache.values()) void p.then((t) => t && URL.revokeObjectURL(t.url));
  cache.clear();
  bgfCache.clear();
  const { dir, textures } = await host.listTextures(editor.get().prefs.texturesDir);
  knownSet = new Set(textures.map((t) => t.number));
  library.set({ dir, numbers: textures.map((t) => t.number), loading: false, version: library.get().version + 1 });
}

export function loadTexture(number: number): Promise<TextureInfo | null> {
  let p = cache.get(number);
  if (!p) {
    p = decode(number).catch(() => null);
    cache.set(number, p);
  }
  return p;
}

async function decode(number: number): Promise<TextureInfo | null> {
  if (!knownSet.has(number)) return null;
  const bgf = await parseBgf(await host.readTexture(gridTextureName(number)));
  const bmp = bgf.bitmaps[0];
  if (!bmp) return null;
  // Stored transposed: stored (x, y) is upright (y, x).
  const w = bmp.height;
  const h = bmp.width;
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext("2d")!;
  const image = ctx.createImageData(w, h);
  for (let sy = 0; sy < bmp.height; sy++) {
    for (let sx = 0; sx < bmp.width; sx++) {
      const index = bmp.pixels[sy * bmp.width + sx]!;
      const o = (sx * w + sy) * 4;
      image.data[o] = PALETTE[index * 3]!;
      image.data[o + 1] = PALETTE[index * 3 + 1]!;
      image.data[o + 2] = PALETTE[index * 3 + 2]!;
      image.data[o + 3] = index === TRANSPARENT_INDEX ? 0 : 255;
    }
  }
  ctx.putImageData(image, 0, 0);
  const blob = await canvas.convertToBlob({ type: "image/png" });
  return { number, width: w, height: h, shrink: bgf.shrink, url: URL.createObjectURL(blob), frames: bgf.bitmaps.length };
}

/** A texture's width in editor units, for x-offset alignment; null if unknown. */
export async function textureWidth(number: number): Promise<number | null> {
  const t = await loadTexture(number);
  return t ? Math.max(1, Math.trunc(t.width / t.shrink)) : null;
}

export function useTexture(number: number): TextureInfo | null | undefined {
  const [info, setInfo] = useState<TextureInfo | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    if (number === 0) return;
    void loadTexture(number).then((t) => live && setInfo(t));
    return () => {
      live = false;
    };
  }, [number]);
  return number === 0 ? null : info;
}
