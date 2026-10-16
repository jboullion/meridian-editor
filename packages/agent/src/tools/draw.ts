// The map's drawing tools: lines, rectangles, polygons, circles, torches and things.

import { z } from "zod";
import { insertPath } from "../../../../apps/editor/src/renderer/ops/draw.ts";
import { addThing } from "../../../../apps/editor/src/renderer/ops/edit.ts";
import type { Pt } from "../../../../apps/editor/src/renderer/ops/geom.ts";
import { circleSides, insertShape, insertTorch, polygonPoints, rectanglePoints } from "../../../../apps/editor/src/renderer/ops/shapes.ts";
import { OpError, type Session } from "../session.ts";
import { checkRevision, coord, drawDefaults, edited, ifRevision, point, tool } from "../tool.ts";

function defaultsFor(s: Session, override: z.infer<typeof drawDefaults>) {
  return { ...s.prefs().defaults, ...override };
}

const snap = z.number().int().min(1).optional().describe("Round points to this grid (editor units), as the map's snap does; off by default");

function snapped(points: readonly (readonly [number, number])[], grid: number | undefined): Pt[] {
  return points.map(([x, y]) => (grid ? [Math.round(x / grid) * grid, Math.round(y / grid) * grid] : [Math.round(x), Math.round(y)]) as Pt);
}

export const drawTools = [
  tool({
    name: "draw_path",
    title: "Draw lines",
    description:
      "The Draw tool: a polyline through points. Closed, it makes a loop. Lines snap onto vertices and walls they meet, split the walls they cross, and divide the sectors they cut; each closed face gets a sector (new ones use the drawing defaults). Walls drawing makes two-sided are passable unless defaults.passable is false. Returns the linedefs along the path and the new sectors.",
    input: { points: z.array(point).min(2), closed: z.boolean(), snap, defaults: drawDefaults, ifRevision },
    edits: true,
    run: (s, { points, closed, snap: grid, defaults, ifRevision: rev }) => {
      checkRevision(s, rev);
      let out: ReturnType<typeof insertPath> | null = null;
      const res = edited(s, closed ? "draw loop" : "draw lines", (r) => (out = insertPath(r, snapped(points, grid), closed, defaultsFor(s, defaults))).room);
      const o = out as ReturnType<typeof insertPath> | null;
      return { ...res, path: o?.path, createdLinedefs: o?.created, newSectors: o?.sectors };
    },
  }),

  tool({
    name: "draw_shape",
    title: "Draw a shape",
    description:
      "The Rectangle, Polygon and Circle tools. A rectangle takes two corners; a polygon or circle takes a centre and radius (a circle picks its side count from the radius, as roomedit does). Drawn inside a sector it makes an inner sector, or a solid pillar with pillar: true. Returns the new sectors and the outline's linedefs.",
    input: {
      shape: z.enum(["rectangle", "polygon", "circle"]),
      from: point.optional().describe("Rectangle: one corner"),
      to: point.optional().describe("Rectangle: the opposite corner"),
      center: point.optional().describe("Polygon or circle"),
      radius: z.number().min(8).optional(),
      sides: z.number().int().min(3).max(64).optional().describe("Polygon sides (default: prefs polygonSides)"),
      pillar: z.boolean().optional().describe("Make a solid column instead of an inner sector (default: prefs pillar)"),
      defaults: drawDefaults,
      ifRevision,
    },
    edits: true,
    run: (s, a) => {
      checkRevision(s, a.ifRevision);
      let pts: Pt[];
      if (a.shape === "rectangle") {
        if (!a.from || !a.to) throw new OpError("A rectangle needs from and to.");
        if (Math.abs(a.to[0] - a.from[0]) < 8 || Math.abs(a.to[1] - a.from[1]) < 8) throw new OpError("A rectangle must be at least 8 units each way.");
        pts = rectanglePoints(a.from[0], a.from[1], a.to[0], a.to[1]);
      } else {
        if (!a.center || a.radius === undefined) throw new OpError(`A ${a.shape} needs center and radius.`);
        const r = Math.round(a.radius);
        pts = polygonPoints(a.center[0], a.center[1], a.shape === "circle" ? circleSides(r) : (a.sides ?? s.prefs().polygonSides), r);
      }
      let out: ReturnType<typeof insertShape> | null = null;
      const res = edited(s, `draw ${a.shape}`, (r) => (out = insertShape(r, pts, defaultsFor(s, a.defaults), a.pillar ?? s.prefs().pillar)).room);
      const o = out as ReturnType<typeof insertShape> | null;
      return { ...res, outline: o?.path, newSectors: o?.sectors };
    },
  }),

  tool({
    name: "add_torch",
    title: "Place a torch",
    description: "roomedit's torch: two crossed animated textures on four short linedefs, inside a sector. Its base snaps onto a wall within 4 units.",
    input: { x: coord, y: coord, angle: z.number().int().optional().describe("Degrees it faces: 0 north, 90 east, 180 south, 270 west (default: prefs torchAngle)"), ifRevision },
    edits: true,
    run: (s, { x, y, angle, ifRevision: rev }) => {
      checkRevision(s, rev);
      let anchor: Pt | null = null;
      const res = edited(s, "place torch", (r) => {
        const out = insertTorch(r, x, y, angle ?? s.prefs().torchAngle);
        anchor = out.anchor;
        return out.room;
      });
      return { ...res, anchor };
    },
  }),

  tool({
    name: "add_thing",
    title: "Add a thing",
    description:
      "Add a thing (roomedit's full record). Server 104 loads only rooms with exactly two things, the room-box corners; extra things are notes for the original server. Placing Kod objects is done in the room's Kod, not with things. copyFrom copies another thing's fields.",
    input: { x: coord, y: coord, copyFrom: z.number().int().min(2).optional(), ifRevision },
    edits: true,
    run: (s, { x, y, copyFrom, ifRevision: rev }) => {
      checkRevision(s, rev);
      const res = edited(s, "add thing", (r) => addThing(r, Math.round(x), Math.round(y), copyFrom));
      return { ...res, thing: s.room().things.length - 1, ...(s.target() === "104" ? { warning: "Server 104 needs exactly two things; this room won't compile for 104 until it's removed." } : {}) };
    },
  }),
];
