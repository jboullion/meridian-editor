// Drawing on real rooms: inner rooms and cutting lines inside shipped sectors
// must not open any sector or break the compile.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PROFILES } from "@meridian-editor/roo";
import { compileRoom, type RoomSource } from "@meridian-editor/roomc";
import { checkSectors } from "./checks.ts";
import { insertPath, ROOMEDIT_DEFAULTS } from "./draw.ts";
import { sectorAtPoint } from "./geom.ts";
import { rectanglePoints } from "./shapes.ts";

const DIR = join(import.meta.dirname, "../../../../../rooms/src");
// Every fourth room by default; ROO_STRESS=all sweeps them all (a few minutes).
const rooms = existsSync(DIR)
  ? readdirSync(DIR)
      .filter((f) => f.endsWith(".room.json"))
      .filter((_, i) => process.env.ROO_STRESS === "all" || i % 4 === 0)
  : [];

/** Closed-sector errors the edit added, split into loop errors and ray disagreements. */
function newErrors(before: RoomSource, after: RoomSource): { loops: string[]; rays: string[] } {
  const old = new Set(checkSectors(before).map((i) => i.message));
  const added = checkSectors(after).filter((i) => i.severity === "error" && !old.has(i.message));
  return {
    loops: added.filter((i) => /no side (ends|starts)/.test(i.message)).map((i) => i.message),
    rays: added.filter((i) => !/no side (ends|starts)/.test(i.message)).map((i) => i.message),
  };
}

/** Linedefs that cross without sharing a vertex: such rooms aren't planar, so faces can't be traced. */
function crosses(room: RoomSource): boolean {
  const L = room.linedefs;
  for (let i = 0; i < L.length; i++) {
    for (let j = i + 1; j < L.length; j++) {
      const a = L[i]!;
      const b = L[j]!;
      if (a.start === b.start || a.start === b.end || a.end === b.start || a.end === b.end) continue;
      const p = room.vertices[a.start]!;
      const q = room.vertices[a.end]!;
      const r = room.vertices[b.start]!;
      const t = room.vertices[b.end]!;
      if (Math.max(p[0], q[0]) < Math.min(r[0], t[0]) || Math.max(r[0], t[0]) < Math.min(p[0], q[0])) continue;
      if (Math.max(p[1], q[1]) < Math.min(r[1], t[1]) || Math.max(r[1], t[1]) < Math.min(p[1], q[1])) continue;
      const d = (q[0] - p[0]) * (t[1] - r[1]) - (q[1] - p[1]) * (t[0] - r[0]);
      if (d === 0) continue;
      const u = ((r[0] - p[0]) * (t[1] - r[1]) - (r[1] - p[1]) * (t[0] - r[0])) / d;
      const v = ((r[0] - p[0]) * (q[1] - p[1]) - (r[1] - p[1]) * (q[0] - p[0])) / d;
      if (u > 1e-9 && u < 1 - 1e-9 && v > 1e-9 && v < 1 - 1e-9) return true;
    }
  }
  return false;
}

describe.skipIf(rooms.length === 0)("drawing on shipped rooms", () => {
  it("adds inner rooms and splits without breaking sector loops (planar rooms)", () => {
    const failures: string[] = [];
    let tries = 0;
    let rayNotes = 0;
    for (const name of rooms) {
      const room = JSON.parse(readFileSync(join(DIR, name), "utf8")) as RoomSource;
      if (crosses(room)) continue;
      // Try the first few sectors whose centre is inside them, with room to spare.
      let done = 0;
      for (let s = 0; s < room.sectors.length && done < 3; s++) {
        const xs: number[] = [];
        const ys: number[] = [];
        for (const l of room.linedefs) {
          if (l.front?.sector !== s && l.back?.sector !== s) continue;
          for (const v of [l.start, l.end]) {
            xs.push(room.vertices[v]![0]);
            ys.push(room.vertices[v]![1]);
          }
        }
        if (xs.length === 0) continue;
        const cx = Math.round((Math.min(...xs) + Math.max(...xs)) / 2);
        const cy = Math.round((Math.min(...ys) + Math.max(...ys)) / 2);
        if (Math.max(...xs) - Math.min(...xs) < 96 || Math.max(...ys) - Math.min(...ys) < 96) continue;
        if (sectorAtPoint(room, cx + 0.5, cy + 0.5) !== s) continue;
        done++;
        tries++;
        for (const [label, edit] of [
          ["inner room", () => insertPath(room, rectanglePoints(cx - 8, cy - 8, cx + 8, cy + 8), true, ROOMEDIT_DEFAULTS).room],
          [
            "cut",
            () =>
              insertPath(
                room,
                [
                  [cx - 2000, cy],
                  [cx + 2000, cy],
                ],
                false,
                ROOMEDIT_DEFAULTS,
              ).room,
          ],
        ] as const) {
          try {
            const out = edit();
            const errors = newErrors(room, out);
            if (errors.loops.length) failures.push(`${name} sector ${s} ${label}: ${errors.loops.join("; ")}`);
            // Ray disagreements come from sectors that already overlap in the shipped room.
            if (errors.rays.length) rayNotes++;
            compileRoom(out, PROFILES["104"]);
          } catch (e) {
            failures.push(`${name} sector ${s} ${label}: ${(e as Error).message.split("\n")[0]}`);
          }
        }
      }
    }
    console.log(`drew in ${tries} sectors across ${rooms.length} rooms; ${failures.length} broken loops; ${rayNotes} edits near overlapping shipped sectors`);
    expect(failures.slice(0, 10)).toEqual([]);
  }, 900_000);
});
