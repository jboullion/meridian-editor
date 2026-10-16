// The texture library: what's there, what textures look like (texture numbers
// have no names, so the agent looks), and where the room uses each one.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { TRANSPARENT_INDEX } from "../../../../apps/editor/src/renderer/textures/bgf.ts";
import { Raster } from "../render/raster.ts";
import { OpError, type Session } from "../session.ts";
import { loadGridTexture, textureSize, texturesFolder } from "../textures.ts";
import { ImageOutput, tool } from "../tool.ts";

let palette: Uint8Array | null = null;

/** The game's palette (assets/blakston.pal), as the editor's library reads it. */
function gamePalette(): Uint8Array {
  if (palette) return palette;
  const text = readFileSync(join(import.meta.dirname, "../../../../apps/editor/src/renderer/assets/blakston.pal"), "utf8");
  const out = new Uint8Array(256 * 3);
  text
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .slice(0, 256)
    .forEach((line, i) => {
      const [r, g, b] = line.trim().split(/\s+/).map(Number);
      out.set([Math.min(255, r ?? 0), Math.min(255, g ?? 0), Math.min(255, b ?? 0)], i * 3);
    });
  palette = out;
  return out;
}

/** "1000-1012, 1015": a sorted list of numbers as ranges. */
function ranges(numbers: readonly number[]): string {
  const out: string[] = [];
  for (let i = 0; i < numbers.length; ) {
    let j = i;
    while (j + 1 < numbers.length && numbers[j + 1] === numbers[j]! + 1) j++;
    out.push(j > i ? `${numbers[i]}-${numbers[j]}` : String(numbers[i]));
    i = j + 1;
  }
  return out.join(", ");
}

async function known(s: Session, fresh = false): Promise<number[]> {
  const k = await s.knownTextures(fresh);
  if (!k) throw new OpError("No texture folder: the installed Meridian 104 client's resource folder wasn't found. Set texturesDir with set_prefs.");
  return [...k].sort((a, b) => a - b);
}

export const textureTools = [
  tool({
    name: "list_textures",
    title: "List textures",
    description:
      "The texture numbers in the library (grdNNNNN.bgf), as ranges, optionally between from and to. With numbers, also each one's size in texels and in editor units (a wall texture repeats every editorWidth units), and its frame count (animated if > 1). Use view_textures to see them.",
    input: {
      from: z.number().int().min(0).optional(),
      to: z.number().int().min(0).optional(),
      numbers: z.array(z.number().int().min(0)).max(200).optional(),
    },
    annotations: { readOnlyHint: true },
    run: async (s, { from, to, numbers }) => {
      // Read the folder again each time, as Reload texture library does.
      const all = await known(s, true);
      const inRange = all.filter((n) => (from === undefined || n >= from) && (to === undefined || n <= to));
      const sizes = numbers ? await Promise.all(numbers.map(async (n) => ({ number: n, ...((await textureSize(s, n)) ?? { missing: true }) }))) : undefined;
      return { folder: await texturesFolder(s), total: all.length, count: inRange.length, numbers: ranges(inRange), ...(sizes ? { sizes } : {}) };
    },
  }),

  tool({
    name: "view_textures",
    title: "Look at textures",
    description: "A contact sheet of textures, upright as they show on a wall, each labelled with its number. Up to 64 at a time. Transparent texels show as a magenta checker.",
    input: {
      numbers: z.array(z.number().int().min(0)).min(1).max(64),
      tile: z.number().int().min(32).max(256).optional().describe("Tile size in pixels (default 128)"),
    },
    annotations: { readOnlyHint: true },
    run: async (s, { numbers, tile = 128 }) => {
      const pal = gamePalette();
      const cols = Math.min(8, numbers.length);
      const rows = Math.ceil(numbers.length / cols);
      const label = 18;
      const r = new Raster(cols * (tile + 8) + 8, rows * (tile + label + 8) + 8, [22, 24, 29]);
      const missing: number[] = [];
      const info: Record<string, unknown>[] = [];
      for (const [i, n] of numbers.entries()) {
        const x0 = 8 + (i % cols) * (tile + 8);
        const y0 = 8 + Math.floor(i / cols) * (tile + label + 8);
        const bgf = await loadGridTexture(s, n);
        const bmp = bgf?.bitmaps[0];
        if (!bgf || !bmp) {
          missing.push(n);
          r.rect(x0, y0, x0 + tile - 1, y0 + tile - 1, [60, 30, 30]);
        } else {
          // Stored transposed: stored (x, y) is upright (y, x).
          const w = bmp.height;
          const h = bmp.width;
          const scale = Math.min(tile / w, tile / h);
          const dw = Math.max(1, Math.round(w * scale));
          const dh = Math.max(1, Math.round(h * scale));
          for (let y = 0; y < dh; y++) {
            for (let x = 0; x < dw; x++) {
              const ux = Math.min(w - 1, Math.floor(x / scale));
              const uy = Math.min(h - 1, Math.floor(y / scale));
              const p = bmp.pixels[ux * bmp.width + uy]!;
              if (p === TRANSPARENT_INDEX) r.pixel(x0 + x, y0 + y, (x >> 3) % 2 === (y >> 3) % 2 ? [255, 0, 255] : [90, 0, 90]);
              else r.pixel(x0 + x, y0 + y, [pal[p * 3]!, pal[p * 3 + 1]!, pal[p * 3 + 2]!]);
            }
          }
          info.push({ number: n, width: w, height: h, shrink: bgf.shrink, frames: bgf.bitmaps.length });
        }
        r.text(String(n), x0, y0 + tile + 4, [255, 255, 255], 1);
      }
      return new ImageOutput(r.png(), { textures: info, ...(missing.length ? { missing } : {}) });
    },
  }),

  tool({
    name: "textures_in_use",
    title: "Textures the room uses",
    description: "Every texture the room uses, with where: wall sides (linedef, side, part) and sector floors and ceilings.",
    input: {},
    annotations: { readOnlyHint: true },
    run: (s) => {
      const room = s.room();
      const uses = new Map<number, { walls: string[]; floors: number[]; ceilings: number[] }>();
      const at = (n: number) => {
        let u = uses.get(n);
        if (!u) uses.set(n, (u = { walls: [], floors: [], ceilings: [] }));
        return u;
      };
      room.linedefs.forEach((l, i) => {
        for (const [side, sd] of [
          ["front", l.front],
          ["back", l.back],
        ] as const) {
          if (!sd) continue;
          for (const part of ["normal", "above", "below"] as const) if (sd[part]) at(sd[part]).walls.push(`${i} ${side} ${part}`);
        }
      });
      room.sectors.forEach((sec, i) => {
        if (sec.floorTexture) at(sec.floorTexture).floors.push(i);
        if (sec.ceilingTexture) at(sec.ceilingTexture).ceilings.push(i);
      });
      return {
        textures: [...uses]
          .sort((a, b) => a[0] - b[0])
          .map(([n, u]) => ({ texture: n, ...(u.walls.length ? { walls: u.walls.length > 40 ? [...u.walls.slice(0, 40), `…${u.walls.length - 40} more`] : u.walls } : {}), ...(u.floors.length ? { floors: u.floors } : {}), ...(u.ceilings.length ? { ceilings: u.ceilings } : {}) })),
      };
    },
  }),
];
