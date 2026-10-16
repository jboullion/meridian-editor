// The inspector: every field of the selection, several items at once; sides,
// flags by name, slopes; and Preferences.

import { z } from "zod";
import { SF } from "@meridian-editor/roo";
import type { RoomSource, SourceSide, SourceSlope } from "@meridian-editor/roomc";
import { OpError, type AgentPrefs } from "../session.ts";
import { changeFlags, describeFlags, SECTOR_FIELDS, SECTOR_FLAGS, WALL_FIELDS, WALL_FLAGS } from "../flags.ts";
import { checkRevision, edited, ifRevision, index, indices, needIndices, tool } from "../tool.ts";

const int = z.number().int();
const side = z.enum(["front", "back", "both"]).describe("Which side of each linedef: front (+, right going start→end), back (−), or both");

const sectorPatch = z
  .object({
    floorHeight: int,
    ceilingHeight: int,
    floorTexture: int.min(0),
    ceilingTexture: int.min(0),
    light: int.min(0).max(255),
    serverId: int.min(0),
    xOffset: int,
    yOffset: int,
    animateSpeed: int.min(0),
    flags: int.min(0).describe("Raw SF bits; prefer set_flags"),
  })
  .partial()
  .strict();

const sidePatch = z
  .object({
    normal: int.min(0).describe("Texture number on the wall's middle (a solid wall, or a see-through texture on a two-sided one)"),
    above: int.min(0).describe("Texture above a two-sided wall: between this sector's ceiling and a lower one beyond"),
    below: int.min(0).describe("Texture below: between a higher floor beyond and this one"),
    xOffset: int,
    yOffset: int,
    serverId: int.min(0),
    animateSpeed: int.min(0),
    sector: int.min(-1).describe("The sector this side faces"),
    flags: int.min(0).describe("Raw WF bits; prefer set_flags"),
  })
  .partial()
  .strict();

const thingPatch = z
  .object({ x: int, y: int, type: int, angle: int, when: int, xExit: int, yExit: int, flags: int, comment: z.string() })
  .partial()
  .strict();

const vertexPatch = z.object({ x: int, y: int }).partial().strict();
const linedefPatch = z.object({ start: int.min(0), end: int.min(0) }).partial().strict();

function patchSides(room: RoomSource, list: readonly number[], which: "front" | "back" | "both", fn: (s: SourceSide) => SourceSide): RoomSource {
  const linedefs = room.linedefs.slice();
  let touched = 0;
  for (const i of list) {
    const l = linedefs[i]!;
    const next = { ...l };
    for (const w of which === "both" ? (["front", "back"] as const) : [which]) {
      const sd = l[w];
      if (!sd) continue;
      next[w] = fn(sd);
      touched++;
    }
    linedefs[i] = next;
  }
  if (!touched) throw new OpError(`None of those linedefs has a ${which === "both" ? "" : `${which} `}side. Add one with set_sides.`);
  return { ...room, linedefs };
}

const prefsSchema = z
  .object({
    defaults: z
      .object({
        floorHeight: int,
        ceilingHeight: int,
        floorTexture: int.min(0),
        ceilingTexture: int.min(0),
        light: int.min(0).max(255),
        wallTexture: int.min(0),
        upperTexture: int.min(0),
        lowerTexture: int.min(0),
        passable: z.boolean(),
      })
      .partial(),
    polygonSides: int.min(3).max(64),
    pillar: z.boolean(),
    torchAngle: int,
    texturesDir: z.string(),
    kodDir: z.string(),
  })
  .partial();

export const propsTools = [
  tool({
    name: "set_properties",
    title: "Set properties",
    description:
      "The inspector: set fields on one or many items at once. kind room: {roomId}. vertex: {x, y}. sector: heights, textures, light, serverId, offsets, animateSpeed. thing: x, y and roomedit's fields. linedef: {start, end} vertices, or with side, that side's textures, offsets, serverId, animateSpeed and sector. Texture 0 means none.",
    input: {
      kind: z.enum(["room", "vertex", "linedef", "sector", "thing"]),
      indices: z.array(index).optional().describe("Not for kind room"),
      side: side.optional().describe("linedef only: edit a side's fields"),
      patch: z.record(z.string(), z.unknown()),
      ifRevision,
    },
    edits: true,
    run: (s, { kind: k, indices: list, side: which, patch, ifRevision: rev }) => {
      checkRevision(s, rev);
      if (k === "room") {
        const p = z.object({ roomId: int.min(0) }).strict().parse(patch);
        return edited(s, "set room id", (r) => ({ ...r, ...p }));
      }
      if (!list?.length) throw new OpError("Give indices.");
      needIndices(s.room(), k, list);
      const label = `set ${k} ${Object.keys(patch).join(", ")}`;
      switch (k) {
        case "vertex": {
          const p = vertexPatch.parse(patch);
          return edited(s, label, (r) => ({ ...r, vertices: r.vertices.map((v, i) => (list.includes(i) ? [p.x ?? v[0], p.y ?? v[1]] : v)) }));
        }
        case "sector": {
          const p = sectorPatch.parse(patch);
          return edited(s, label, (r) => ({ ...r, sectors: r.sectors.map((x, i) => (list.includes(i) ? { ...x, ...p } : x)) }));
        }
        case "thing": {
          const p = thingPatch.parse(patch);
          return edited(s, label, (r) => ({ ...r, things: r.things.map((x, i) => (list.includes(i) ? { ...x, ...p } : x)) }));
        }
        case "linedef": {
          if (which) {
            const p = sidePatch.parse(patch);
            if (p.sector !== undefined && p.sector >= s.room().sectors.length) throw new OpError(`There is no sector ${p.sector}.`);
            return edited(s, `set ${which} side ${Object.keys(p).join(", ")}`, (r) => patchSides(r, list, which, (sd) => ({ ...sd, ...p })));
          }
          const p = linedefPatch.parse(patch);
          for (const v of [p.start, p.end]) if (v !== undefined && v >= s.room().vertices.length) throw new OpError(`There is no vertex ${v}.`);
          return edited(s, label, (r) => ({ ...r, linedefs: r.linedefs.map((l, i) => (list.includes(i) ? { ...l, ...p } : l)) }));
        }
      }
    },
  }),

  tool({
    name: "set_sides",
    title: "Add or remove sides",
    description: "Add a side to linedefs that lack one (a copy of the other side with zero offsets, or a blank side facing sector 0), or remove sides, making walls solid from that side.",
    input: { linedefs: z.array(index).min(1), which: z.enum(["front", "back"]), action: z.enum(["add", "remove"]), ifRevision },
    edits: true,
    run: (s, { linedefs: list, which, action, ifRevision: rev }) => {
      checkRevision(s, rev);
      needIndices(s.room(), "linedef", list);
      return edited(s, `${action} ${which} sides`, (r) => {
        const linedefs = r.linedefs.slice();
        for (const i of list) {
          const l = linedefs[i]!;
          if (action === "remove") linedefs[i] = { ...l, [which]: null };
          else if (!l[which]) {
            const other = which === "front" ? l.back : l.front;
            const sd: SourceSide = other ? { ...other, xOffset: 0, yOffset: 0 } : { sector: 0, normal: 0, above: 0, below: 0, xOffset: 0, yOffset: 0, serverId: 0, animateSpeed: 0, flags: 0 };
            linedefs[i] = { ...l, [which]: sd };
          }
        }
        return { ...r, linedefs };
      });
    },
  }),

  tool({
    name: "set_flags",
    title: "Set flags",
    description: `Turn flags on or off by name, and set flag fields, on sectors or linedef sides. Wall flags: ${Object.keys(WALL_FLAGS).join(", ")}; fields ${Object.keys(WALL_FIELDS).join(", ")} (translucency and noHTile are original-server only). Sector flags: ${Object.keys(SECTOR_FLAGS).join(", ")} (use set_slope for the sloped ones); fields ${Object.keys(SECTOR_FIELDS).join(", ")} (depth 0–3 is water).`,
    input: {
      kind: z.enum(["linedef", "sector"]),
      indices,
      side: side.optional().describe("linedef only; default both"),
      on: z.array(z.string()).optional(),
      off: z.array(z.string()).optional(),
      fields: z.record(z.string(), z.number().int()).optional().describe('Such as {"scrollSpeed": 2, "scrollDirection": 4} or {"depth": 1}'),
      ifRevision,
    },
    edits: true,
    run: (s, { kind: k, indices: list, side: which, on, off, fields, ifRevision: rev }) => {
      checkRevision(s, rev);
      needIndices(s.room(), k, list);
      const change = (set: "wall" | "sector", f: number) => changeFlags(set, f, on ?? [], off ?? [], fields ?? {});
      if (k === "sector") {
        const res = edited(s, "set sector flags", (r) => ({ ...r, sectors: r.sectors.map((x, i) => (list.includes(i) ? { ...x, flags: change("sector", x.flags) } : x)) }));
        return { ...res, flags: list.map((i) => ({ sector: i, ...describeFlags("sector", s.room().sectors[i]!.flags) })) };
      }
      const res = edited(s, "set wall flags", (r) => patchSides(r, list, which ?? "both", (sd) => ({ ...sd, flags: change("wall", sd.flags) })));
      return { ...res, flags: list.map((i) => ({ linedef: i, front: s.room().linedefs[i]!.front && describeFlags("wall", s.room().linedefs[i]!.front!.flags), back: s.room().linedefs[i]!.back && describeFlags("wall", s.room().linedefs[i]!.back!.flags) })) };
    },
  }),

  tool({
    name: "set_slope",
    title: "Set a slope",
    description:
      "Set a sector's floor or ceiling slope: three points [x, y, z] that should be vertices of the sector (z is the height there; the first is the texture origin), and the texture angle in client units (4096 a circle). null makes it flat again. The sloped flag follows.",
    input: {
      sector: index,
      which: z.enum(["floor", "ceiling"]),
      slope: z
        .object({
          angle: int.optional(),
          points: z.tuple([z.tuple([int, int, int]), z.tuple([int, int, int]), z.tuple([int, int, int])]),
        })
        .nullable(),
      ifRevision,
    },
    edits: true,
    run: (s, { sector, which, slope, ifRevision: rev }) => {
      checkRevision(s, rev);
      needIndices(s.room(), "sector", [sector]);
      const key = which === "floor" ? "floorSlope" : "ceilingSlope";
      const bit = which === "floor" ? SF.SLOPED_FLOOR : SF.SLOPED_CEILING;
      const room = s.room();
      const missing = slope?.points.filter(([x, y]) => !room.vertices.some(([vx, vy]) => vx === x && vy === y)) ?? [];
      const res = edited(s, `set ${which} slope`, (r) => ({
        ...r,
        sectors: r.sectors.map((x, i) => {
          if (i !== sector) return x;
          if (!slope) return { ...x, [key]: null, flags: x.flags & ~bit };
          const next: SourceSlope = { angle: slope.angle ?? x[key]?.angle ?? 0, points: slope.points };
          return { ...x, [key]: next, flags: x.flags | bit };
        }),
      }));
      return { ...res, ...(missing.length ? { warning: `Points not on a vertex: ${missing.map((p) => `(${p[0]}, ${p[1]})`).join(", ")}` } : {}) };
    },
  }),

  tool({
    name: "clear_compat",
    title: "Compile as current roomedit",
    description: "Drop the older-roomedit quirks an import detected (RoomSource.compat), so the room compiles the way current roomedit does. New rooms have none.",
    input: { ifRevision },
    edits: true,
    run: (s, { ifRevision: rev }) => {
      checkRevision(s, rev);
      return edited(s, "clear compat", (r) => (r.compat ? { ...r, compat: undefined } : r));
    },
  }),

  tool({
    name: "get_prefs",
    title: "Preferences",
    description: "Drawing defaults (what new sectors and walls start as), polygon sides, pillar mode, torch direction, and the texture and Kod folders.",
    input: {},
    annotations: { readOnlyHint: true },
    run: (s) => ({ ...s.prefs() }),
  }),

  tool({
    name: "set_prefs",
    title: "Set preferences",
    description: "Change Preferences for this session (fields not given stay). Drawing tools also take one-off defaults.",
    input: { prefs: prefsSchema },
    run: (s, { prefs }) => {
      const cur = s.prefs();
      const next: AgentPrefs = { ...cur, ...prefs, defaults: { ...cur.defaults, ...prefs.defaults } };
      s.setPrefs(next);
      return { ...next };
    },
  }),
];
