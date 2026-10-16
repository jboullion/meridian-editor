// The 2D map as a picture: sectors shaded by floor, ceiling or light, walls
// (solid, open, blocked), the room box, Kod placements, and index labels so an
// agent can tell which sector or linedef is which.

import { WF } from "@meridian-editor/roo";
import type { RoomSource } from "@meridian-editor/roomc";
import { roomBounds, sectorPieces } from "../../../../apps/editor/src/renderer/geometry.ts";
import { kodMarks, roomBox } from "../../../../apps/editor/src/renderer/kod/kodRooms.ts";
import type { Session } from "../session.ts";
import { sectorLoops } from "../tools/read.ts";
import { Raster, type Rgb } from "./raster.ts";

export interface MapOptions {
  /** [minX, minY, maxX, maxY] in editor units; default the whole room. */
  bbox?: [number, number, number, number];
  colorBy?: "floor" | "ceiling" | "light";
  labels?: ("sector" | "linedef" | "vertex" | "thing")[];
  highlight?: { kind: "sector" | "linedef" | "vertex" | "thing"; indices: number[] };
  /** Longest side in pixels. */
  size?: number;
  kod?: boolean;
  /** A path to draw (a walk), in editor units. */
  path?: [number, number][];
}

const BG: Rgb = [22, 24, 29];
const GRID: Rgb = [40, 44, 52];
const SOLID: Rgb = [235, 235, 235];
const OPEN: Rgb = [120, 128, 140];
const BLOCKED: Rgb = [235, 120, 60];
const HIGHLIGHT: Rgb = [255, 70, 200];
const BOX: Rgb = [170, 90, 255];
const KOD: Record<string, Rgb> = { exit: [60, 220, 90], locked: [230, 50, 50], arrival: [80, 160, 255], generator: [250, 200, 40], object: [200, 200, 120], sound: [120, 200, 220] };

/** Blue → green → yellow → red. */
function ramp(t: number): Rgb {
  const stops: Rgb[] = [
    [40, 70, 150],
    [40, 140, 110],
    [190, 180, 60],
    [190, 70, 50],
  ];
  const x = Math.max(0, Math.min(1, t)) * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(x));
  const f = x - i;
  const a = stops[i]!;
  const b = stops[i + 1]!;
  return [Math.round(a[0] + (b[0] - a[0]) * f), Math.round(a[1] + (b[1] - a[1]) * f), Math.round(a[2] + (b[2] - a[2]) * f)];
}

export async function renderMap(s: Session, o: MapOptions): Promise<{ png: Uint8Array; info: Record<string, unknown> }> {
  const room: RoomSource = s.room();
  const b = roomBounds(room);
  const [minX, minY, maxX, maxY] = o.bbox ?? [b.minX - 32, b.minY - 32, b.maxX + 32, b.maxY + 32];
  const size = o.size ?? 1024;
  const scale = size / Math.max(maxX - minX, maxY - minY, 1);
  const W = Math.max(64, Math.round((maxX - minX) * scale));
  const H = Math.max(64, Math.round((maxY - minY) * scale));
  const px = (x: number): number => (x - minX) * scale;
  const py = (y: number): number => (maxY - y) * scale;
  const r = new Raster(W, H, BG);

  // Grid squares (64 units), when they're big enough to see.
  if (scale * 64 >= 6) {
    for (let x = Math.ceil(minX / 64) * 64; x <= maxX; x += 64) r.line(px(x), 0, px(x), H, GRID);
    for (let y = Math.ceil(minY / 64) * 64; y <= maxY; y += 64) r.line(0, py(y), W, py(y), GRID);
  }

  // Sectors.
  const colorBy = o.colorBy ?? "floor";
  const value = (i: number): number => {
    const sec = room.sectors[i]!;
    return colorBy === "floor" ? sec.floorHeight : colorBy === "ceiling" ? sec.ceilingHeight : sec.light;
  };
  const values = room.sectors.map((_, i) => value(i));
  const lo = values.length ? Math.min(...values) : 0;
  const hi = values.length ? Math.max(...values) : 1;
  const colour = (i: number): Rgb => ramp(hi === lo ? 0.35 : (value(i) - lo) / (hi - lo));
  const hl = (k: string, i: number): boolean => o.highlight?.kind === k && o.highlight.indices.includes(i);

  const c = s.compile();
  const labelAt = new Map<number, { x: number; y: number; area: number }>();
  if (c.ok) {
    for (const p of sectorPieces(c.file, c.origin)) {
      const ring = Array.from(p.points, (v, k) => (k % 2 ? py(v) : px(v)));
      r.fillRings([ring], colour(p.sector), 0.75);
      if (hl("sector", p.sector)) r.fillRings([ring], HIGHLIGHT, 0.45);
      const area = (p.maxX - p.minX) * (p.maxY - p.minY);
      if (area > (labelAt.get(p.sector)?.area ?? 0)) {
        let cx = 0;
        let cy = 0;
        const n = p.points.length / 2;
        for (let k = 0; k < n; k++) {
          cx += p.points[k * 2]!;
          cy += p.points[k * 2 + 1]!;
        }
        labelAt.set(p.sector, { x: cx / n, y: cy / n, area });
      }
    }
  } else {
    room.sectors.forEach((_, i) => {
      const loops = sectorLoops(room, i);
      const rings = loops.map((l) => l.points.flatMap(([x, y]) => [px(x), py(y)]));
      r.fillRings(rings, colour(i), 0.75);
      if (hl("sector", i)) r.fillRings(rings, HIGHLIGHT, 0.45);
      const outer = loops.filter((l) => !l.hole).sort((a, b2) => b2.area - a.area)[0];
      if (outer) labelAt.set(i, { x: outer.points.reduce((n, p) => n + p[0], 0) / outer.points.length, y: outer.points.reduce((n, p) => n + p[1], 0) / outer.points.length, area: outer.area });
    });
  }

  // The room box.
  const box = room.things.length >= 2 ? room.things.slice(0, 2) : null;
  if (box) {
    const [a, d] = box as [{ x: number; y: number }, { x: number; y: number }];
    const [x0, x1, y0, y1] = [px(Math.min(a.x, d.x)), px(Math.max(a.x, d.x)), py(Math.max(a.y, d.y)), py(Math.min(a.y, d.y))];
    r.line(x0, y0, x1, y0, BOX, 1, 6);
    r.line(x1, y0, x1, y1, BOX, 1, 6);
    r.line(x1, y1, x0, y1, BOX, 1, 6);
    r.line(x0, y1, x0, y0, BOX, 1, 6);
  }

  // Walls: solid, open (passable both ways), blocked (two-sided, not passable).
  room.linedefs.forEach((l, i) => {
    const a = room.vertices[l.start]!;
    const d = room.vertices[l.end]!;
    const two = !!(l.front && l.back);
    const passable = two && !!(l.front!.flags & WF.PASSABLE) && !!(l.back!.flags & WF.PASSABLE);
    const col = hl("linedef", i) ? HIGHLIGHT : !two ? SOLID : passable ? OPEN : BLOCKED;
    r.line(px(a[0]), py(a[1]), px(d[0]), py(d[1]), col, hl("linedef", i) ? 3 : two ? 1 : 2);
  });

  // Kod placements.
  let kodNote: string | null = null;
  if (o.kod !== false) {
    const k = await s.kodRoom();
    const rb = roomBox(room.things);
    if (k.room && rb) {
      for (const m of kodMarks(k.room, rb)) {
        const col = KOD[m.kind] ?? SOLID;
        const h = Math.max(3, scale * 12);
        if (m.kind === "arrival") {
          r.line(px(m.x) - h, py(m.y) - h, px(m.x) + h, py(m.y) + h, col, 2);
          r.line(px(m.x) - h, py(m.y) + h, px(m.x) + h, py(m.y) - h, col, 2);
        } else r.rect(px(m.x) - h, py(m.y) - h, px(m.x) + h, py(m.y) + h, col, 0.85);
      }
      kodNote = k.room.className;
    }
  }

  // A walk.
  if (o.path && o.path.length > 1) {
    for (let i = 1; i < o.path.length; i++) r.line(px(o.path[i - 1]![0]), py(o.path[i - 1]![1]), px(o.path[i]![0]), py(o.path[i]![1]), [255, 255, 255], 2, 4);
  }

  // Vertices and things.
  const labels = new Set(o.labels ?? ["sector"]);
  if (labels.has("vertex") || o.highlight?.kind === "vertex") {
    room.vertices.forEach(([x, y], i) => r.rect(px(x) - 1.5, py(y) - 1.5, px(x) + 1.5, py(y) + 1.5, hl("vertex", i) ? HIGHLIGHT : [255, 255, 255]));
  }
  room.things.forEach((t, i) => {
    const col: Rgb = hl("thing", i) ? HIGHLIGHT : i < 2 ? BOX : [255, 255, 255];
    r.rect(px(t.x) - 3, py(t.y) - 3, px(t.x) + 3, py(t.y) + 3, col);
  });

  // Labels last, so they sit on top.
  const textScale = W >= 900 ? 2 : 1;
  const put = (text: string, x: number, y: number, col: Rgb, sc = textScale): void => {
    const w = text.length * 6 * sc;
    r.text(text, x - w / 2, y - 3.5 * sc, col, sc);
  };
  if (labels.has("sector")) for (const [i, p] of labelAt) put(String(i), px(p.x), py(p.y), [255, 255, 255]);
  if (labels.has("linedef")) {
    room.linedefs.forEach((l, i) => {
      const a = room.vertices[l.start]!;
      const d = room.vertices[l.end]!;
      put(String(i), px((a[0] + d[0]) / 2), py((a[1] + d[1]) / 2), [255, 230, 90], 1);
    });
  }
  if (labels.has("vertex")) room.vertices.forEach(([x, y], i) => r.text(String(i), px(x) + 3, py(y) + 2, [140, 230, 255], 1));
  if (labels.has("thing")) room.things.forEach((t, i) => r.text(`T${i}`, px(t.x) + 4, py(t.y) + 4, [255, 255, 255], 1));

  // Coordinates along the top and left edges.
  const step = [64, 128, 256, 512, 1024, 2048].find((g) => g * scale >= 70) ?? 4096;
  for (let x = Math.ceil(minX / step) * step; x <= maxX; x += step) r.text(String(x), px(x) + 2, 2, [150, 160, 175], 1);
  for (let y = Math.ceil(minY / step) * step; y <= maxY; y += step) r.text(String(y), 2, py(y) + 2, [150, 160, 175], 1);

  return {
    png: r.png(),
    info: {
      size: [W, H],
      bbox: [minX, minY, maxX, maxY],
      pixelsPerUnit: Math.round(scale * 1000) / 1000,
      toEditor: `x = ${minX} + px / ${Math.round(scale * 1000) / 1000}, y = ${maxY} - py / ${Math.round(scale * 1000) / 1000}`,
      shading: { by: colorBy, low: lo, high: hi, ramp: "blue (low) → green → yellow → red (high)" },
      legend: {
        walls: "white thick: solid (one-sided); grey: open (passable); orange: two-sided but not passable",
        roomBox: "purple dashed, with corner things as purple squares",
        labels: "white numbers: sectors; yellow: linedefs; cyan: vertices; T: things",
        kod: kodNote ? `${kodNote}: green squares exits, red locked doors, blue X arrival, yellow generators, khaki objects, teal sounds` : "none",
        grid: "64 units (one Kod square)",
      },
      ...(c.ok ? {} : { note: "The room doesn't compile; sectors are filled from their source loops." }),
    },
  };
}
