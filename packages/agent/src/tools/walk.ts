// Walking the room as a player, headless: the 3D preview's Walker (a port of
// the client's move.c) on the compiled room, facing each target with forward
// held, the way tools/shards/walk.ts drives Shards' PlayerMover.

import { writeFile } from "node:fs/promises";
import { z } from "zod";
import { FINENESS, WF } from "@meridian-editor/roo";
import type { RoomSource } from "@meridian-editor/roomc";
import { cross, nearestOnSegment, segmentIntersection } from "../../../../apps/editor/src/renderer/ops/geom.ts";
import { roomBox } from "../../../../apps/editor/src/renderer/kod/kodRooms.ts";
import { toClientRoom } from "../../../../apps/editor/src/renderer/preview/clientRoom.ts";
import { Walker } from "../../../../apps/editor/src/renderer/preview/walker.ts";
import { resolveInside } from "../../../../apps/editor/src/main/roomsFs.ts";
import { OpError, type Session } from "../session.ts";
import { kodPoint } from "./read.ts";
import { tool } from "../tool.ts";

const FRAME = 16;
const REACHED = 32;

const place = z
  .union([z.tuple([z.number(), z.number()]).describe("[x, y] editor units"), z.string().regex(/^\d+\s*,\s*\d+$/).describe('"row,col": the centre of a Kod square, 1-based')])
  .describe('An editor point [x, y], or a Kod square "row,col"');

type Place = z.infer<typeof place>;

function toClient(room: RoomSource, p: Place): { x: number; y: number } {
  const box = roomBox(room.things);
  if (!box) throw new OpError("The room has no room box (things 0 and 1).");
  if (typeof p === "string") {
    const [r, c] = p.split(",").map((n) => Number(n.trim()));
    return { x: (c! - 0.5) * FINENESS, y: (r! - 0.5) * FINENESS };
  }
  return { x: (p[0] - box.left) * 16, y: (box.top - p[1]) * 16 };
}

function toEditor(room: RoomSource, x: number, y: number): [number, number] {
  const box = roomBox(room.things)!;
  return [Math.round((box.left + x / 16) * 10) / 10, Math.round((box.top - y / 16) * 10) / 10];
}

/**
 * What stopped a walk at `stop` heading for `target` (editor units): the first
 * linedef just ahead, or the nearest one, or the room box's edge.
 */
function blocker(room: RoomSource, stop: [number, number], target: [number, number], z: number): Record<string, unknown> | string {
  const len = Math.hypot(target[0] - stop[0], target[1] - stop[1]) || 1;
  const ahead: [number, number] = [stop[0] + ((target[0] - stop[0]) / len) * 40, stop[1] + ((target[1] - stop[1]) / len) * 40];
  let best: number | null = null;
  let bestT = Infinity;
  room.linedefs.forEach((l, i) => {
    const hit = segmentIntersection(stop, ahead, room.vertices[l.start]!, room.vertices[l.end]!);
    if (hit && hit.t < bestT) {
      bestT = hit.t;
      best = i;
    }
  });
  if (best === null) {
    let bestD = 24;
    room.linedefs.forEach((l, i) => {
      const d = nearestOnSegment(stop, room.vertices[l.start]!, room.vertices[l.end]!).d;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
  }
  if (best !== null) return { linedef: best, reason: blockReason(room, best, stop, z) };
  const box = roomBox(room.things);
  const [t0, t1] = room.things;
  if (box && t0 && t1 && (ahead[0] <= box.left || ahead[0] >= Math.max(t0.x, t1.x) || ahead[1] >= box.top || ahead[1] <= Math.min(t0.y, t1.y))) return "the room box's edge";
  return "no floor ahead";
}

/** Why a linedef stops a player on the `at` side of it, standing at floor height z (editor units). */
function blockReason(room: RoomSource, li: number, at: [number, number], z: number): string {
  const l = room.linedefs[li]!;
  const a = room.vertices[l.start]!;
  const b = room.vertices[l.end]!;
  // The front side is on the right going start → end.
  const onFront = cross(a[0], a[1], b[0], b[1], at[0], at[1]) < 0;
  const mine = onFront ? l.front : l.back;
  const other = onFront ? l.back : l.front;
  if (!mine || !other) return "a solid (one-sided) wall";
  const near = room.sectors[mine.sector];
  const far = room.sectors[other.sector];
  if (!near || !far) return "a wall with a side facing no sector";
  const reasons: string[] = [];
  if (!(mine.flags & WF.PASSABLE)) reasons.push("this side of it isn't passable (the passable flag is off)");
  if (far.floorHeight - z > 24) reasons.push(`a step up of ${far.floorHeight - z} (24 at most)`);
  const headroom = Math.min(far.ceilingHeight, near.ceilingHeight) - Math.max(z, far.floorHeight);
  if (headroom < 48) reasons.push(`too low: ${headroom} headroom (48 needed)`);
  return reasons.length ? reasons.join("; ") : "a corner or a wall's end: the player keeps about 15 units from walls";
}

export async function walkRoom(
  s: Session,
  from: Place | "arrival" | undefined,
  steps: { to: Place; expect?: "reached" | "blocked"; why?: string }[],
): Promise<Record<string, unknown>> {
  const room = s.room();
  const c = s.compile();
  if (!c.ok) throw new OpError(`The room doesn't compile for ${c.target}: ${c.diagnostics.find((d) => d.severity === "error")?.message}`);
  const walker = new Walker();
  walker.room = toClientRoom(c.file);

  let start: { x: number; y: number };
  if (from === undefined || from === "arrival") {
    const t = (await s.kodRoom()).room?.teleport;
    if (!t) throw new OpError("No Kod arrival square for this room (no viTeleport_row/col): give from.");
    start = { x: (t.col - 1) * FINENESS + t.fineCol * 16, y: (t.row - 1) * FINENESS + t.fineRow * 16 };
  } else start = toClient(room, from);
  if (walker.floorBase(start.x, start.y) === null) throw new OpError(`The start ${JSON.stringify(from ?? "arrival")} isn't on a floor.`);
  walker.place(Math.round(start.x), Math.round(start.y));

  const where = () => {
    const [ex, ey] = toEditor(room, walker.x, walker.y);
    const k = kodPoint(room, ex, ey);
    return { at: [ex, ey], square: k ? `${k.row},${k.col}` : null, floor: Math.round(walker.z / 16) };
  };

  const results: Record<string, unknown>[] = [];
  let failures = 0;
  for (const step of steps) {
    const target = toClient(room, step.to);
    let best = Infinity;
    let bestAt = 0;
    let reached = false;
    for (let now = 0; now < 30000; now += FRAME) {
      const dx = target.x - walker.x;
      const dy = target.y - walker.y;
      const dist = Math.hypot(dx, dy);
      if (dist < REACHED) {
        reached = true;
        break;
      }
      if (dist < best - 4) {
        best = dist;
        bestAt = now;
      } else if (now - bestAt > 1500) break;
      walker.angle = ((Math.round((Math.atan2(dy, dx) * 4096) / (2 * Math.PI)) % 4096) + 4096) % 4096;
      walker.update({ forward: 1, strafe: 0, run: false }, FRAME);
    }
    // Let a climb or fall finish.
    for (let i = 0; i < 60; i++) walker.update({ forward: 0, strafe: 0, run: false }, FRAME);
    const outcome = reached ? "reached" : "blocked";
    const expected = step.expect ?? "reached";
    if (outcome !== expected) failures++;
    const r: Record<string, unknown> = { to: step.to, ...(step.why ? { why: step.why } : {}), outcome, ...(outcome !== expected ? { expected } : {}), ...where() };
    if (!reached) {
      r.leftToGo = Math.round(best / 16);
      r.stoppedBy = blocker(room, toEditor(room, walker.x, walker.y), toEditor(room, target.x, target.y), walker.z / 16);
    }
    results.push(r);
  }
  return { start: from ?? "arrival", passed: steps.length - failures, failed: failures, steps: results };
}

export const walkTools = [
  tool({
    name: "walk",
    title: "Walk the room",
    description:
      "Walk the room the way the game client moves a player (move.c, as the 3D preview's walk mode): from the Kod arrival square or a point, through each target in turn. Each step is reached or blocked; a blocked step says where it stopped and which linedef stopped it and why (steps over 24 up, under 48 headroom, sides without the passable flag, solid walls). Give expect: blocked for steps that should fail. With saveAs, the steps are written as a .walk.json for tools/shards/walk.ts.",
    input: {
      from: z.union([place, z.literal("arrival")]).optional().describe('Default "arrival", the Kod arrival square'),
      steps: z.array(z.object({ to: place, expect: z.enum(["reached", "blocked"]).optional(), why: z.string().optional() })).min(1),
      saveAs: z.string().optional().describe("Write rooms/new/<name>.walk.json (Kod-square steps only)"),
    },
    run: async (s, { from, steps, saveAs }) => {
      const out = await walkRoom(s, from, steps);
      if (saveAs) {
        if (steps.some((st) => typeof st.to !== "string")) throw new OpError('A .walk.json takes Kod squares ("row,col") only.');
        const name = s.doc()!.name;
        const file = resolveInside(s.roomsDir, `new/${saveAs.replace(/\.walk\.json$/, "")}.walk.json`);
        await writeFile(file, `${JSON.stringify({ room: name, steps: steps.map((st) => ({ to: st.to, ...(st.expect && st.expect !== "reached" ? { expect: st.expect } : {}), ...(st.why ? { why: st.why } : {}) })) }, null, 2)}\n`, "utf8");
        out.saved = file;
      }
      return out;
    },
  }),
];
