// Checks a room's geometry against where its Kod puts things: an exit, a
// generator or an object that lands outside every sector (inside a wall or a
// pillar, or past the room box) is unreachable in the game. Moving the room box
// corners or the walls is the usual cause.

import type { RoomSource } from "@meridian-editor/roomc";
import type { CheckIssue } from "../ops/checks.ts";
import { sectorAtPoint } from "../ops/geom.ts";
import { kodMarks, roomBox, type KodMark, type KodRoom } from "./kodRooms.ts";

/**
 * Whether a player could get to a placement. An exit is a whole square, used
 * by standing anywhere on it, so any floor in the square will do. Anything else
 * counts if there's floor within half a player's width (16 units), since things
 * often stand against a wall.
 */
function reachable(room: RoomSource, m: KodMark, box: { left: number; top: number }): boolean {
  const points: [number, number][] = [];
  if (m.kind === "exit" || m.kind === "locked") {
    const x0 = box.left + (m.col - 1) * 64;
    const y0 = box.top - (m.row - 1) * 64;
    for (let i = 0; i < 5; i++) for (let j = 0; j < 5; j++) points.push([x0 + 4 + i * 14, y0 - 4 - j * 14]);
  } else {
    points.push([m.x, m.y]);
    for (let a = 0; a < 8; a++) points.push([m.x + 16 * Math.cos((a * Math.PI) / 4), m.y + 16 * Math.sin((a * Math.PI) / 4)]);
  }
  return points.some(([x, y]) => sectorAtPoint(room, x, y) !== null);
}

export function checkKodPlacements(room: RoomSource, k: KodRoom): CheckIssue[] {
  const box = roomBox(room.things);
  if (!box) return [{ severity: "error", message: "The room has no room box (things 0 and 1), so Kod rows and columns mean nothing." }];
  const out: CheckIssue[] = [];
  const where = (m: { row: number; col: number; line: number }): string => `row ${m.row}, col ${m.col} (${k.path}:${m.line})`;
  const [t0, t1] = room.things;
  const rows = Math.round(Math.abs(t0!.y - t1!.y) / 64);
  const cols = Math.round(Math.abs(t0!.x - t1!.x) / 64);
  for (const m of kodMarks(k, box)) {
    if (m.kind === "sound") continue;
    if (m.row < 1 || m.col < 1 || m.row > rows || m.col > cols) {
      out.push({ severity: "error", message: `Kod ${m.label} at ${where(m)} is outside the ${rows}×${cols} room box`, at: [m.x, m.y] });
    } else if (!reachable(room, m, box)) {
      out.push({ severity: "warning", message: `Kod ${m.label} at ${where(m)} is ${m.kind === "exit" || m.kind === "locked" ? "a square with no floor" : "inside a wall"}`, at: [m.x, m.y] });
    }
  }
  if (room.roomId && k.rid !== null && room.roomId !== k.rid) {
    out.push({ severity: "warning", message: `The room's ID is ${room.roomId}, but ${k.className} (${k.path}) is RID ${k.rid}` });
  }
  return out;
}
