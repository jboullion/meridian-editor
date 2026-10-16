// roomedit's operations, as the map's right-click menu offers them by mode,
// plus moving, rotating, mirroring, duplicating and deleting.

import { z } from "zod";
import type { RoomSource } from "@meridian-editor/roomc";
import { connectVertices, splitLinedefsAndSector } from "../../../../apps/editor/src/renderer/ops/draw.ts";
import {
  addSlope,
  addVertex,
  alignTexturesX,
  alignTexturesY,
  autoMerge,
  copySelection,
  deleteItems,
  deleteLinedefsJoinSectors,
  deleteVertexJoinLinedefs,
  distributeHeights,
  flipLinedefs,
  freeSectorServerId,
  linkVertices,
  loopFrom,
  makeDoor,
  makeLift,
  makeSectorFromLinedefs,
  mergeSectors,
  mergeVertices,
  mirror,
  moveItems,
  paste,
  rotateScale,
  splitLinedefs,
  verticesOf,
} from "../../../../apps/editor/src/renderer/ops/edit.ts";
import { OpError, type Session } from "../session.ts";
import { textureSize } from "../textures.ts";
import { checkRevision, coord, drawDefaults, edited, ifRevision, index, indices, kind, needIndices, tool } from "../tool.ts";

const atLeast = (n: number) => z.array(index).min(n);

/** The room from an op that returns more, handing the rest to `keep`. */
function take<T extends { room: RoomSource }>(keep: (out: T) => unknown, out: T): RoomSource {
  keep(out);
  return out.room;
}

/** Check the indices, then make one undoable edit. */
function op<K extends "vertex" | "linedef" | "sector" | "thing">(
  s: Session,
  k: K,
  list: readonly number[],
  rev: number | undefined,
  label: string,
  fn: (room: RoomSource) => RoomSource,
  extra?: () => Record<string, unknown>,
): Record<string, unknown> {
  checkRevision(s, rev);
  needIndices(s.room(), k, list);
  const res = edited(s, label, fn);
  return { ...res, ...(extra ? extra() : {}) };
}

export const opsTools = [
  // ------------------------------------------------------------ vertices
  tool({
    name: "add_vertex",
    title: "Add a vertex",
    description: "A lone vertex at a point (Vertices mode, Insert). Link vertices into linedefs with link_vertices.",
    input: { x: coord, y: coord, ifRevision },
    edits: true,
    run: (s, { x, y, ifRevision: rev }) => {
      checkRevision(s, rev);
      let v = -1;
      const res = edited(s, "add vertex", (r) => {
        const out = addVertex(r, Math.round(x), Math.round(y));
        v = out.vertex;
        return out.room;
      });
      return { ...res, vertex: v };
    },
  }),
  tool({
    name: "link_vertices",
    title: "Add linedefs between vertices",
    description: "Join vertices in the given order with new linedefs (Insert); closed joins the last back to the first (Shift+Insert). No sectors are assigned: use make_sector_from_linedefs, or draw_path, which does.",
    input: { vertices: atLeast(2), closed: z.boolean().optional(), ifRevision },
    edits: true,
    run: (s, { vertices, closed, ifRevision: rev }) => {
      if (closed && vertices.length < 3) throw new OpError("Closing a loop needs at least three vertices.");
      let lines: number[] = [];
      return op(s, "vertex", vertices, rev, "link vertices", (r) => take((out) => (lines = out.linedefs), linkVertices(r, vertices, !!closed)), () => ({ linedefs: lines }));
    },
  }),
  tool({
    name: "merge_vertices",
    title: "Merge vertices",
    description: "Merge vertices into the first one given (M).",
    input: { vertices: atLeast(2), ifRevision },
    edits: true,
    run: (s, { vertices, ifRevision: rev }) => op(s, "vertex", vertices, rev, "merge vertices", (r) => mergeVertices(r, vertices)),
  }),
  tool({
    name: "delete_vertex_join",
    title: "Delete vertices and join linedefs",
    description: "Remove vertices that join two linedefs, making each pair one linedef.",
    input: { vertices: atLeast(1), ifRevision },
    edits: true,
    run: (s, { vertices, ifRevision: rev }) => op(s, "vertex", vertices, rev, "delete vertex and join", (r) => [...vertices].sort((a, b) => b - a).reduce(deleteVertexJoinLinedefs, r)),
  }),
  tool({
    name: "connect_vertices",
    title: "Split a sector between two vertices",
    description: "Add a linedef between two vertices of the same sector and split the sector in two there.",
    input: { a: index, b: index, defaults: drawDefaults, ifRevision },
    edits: true,
    run: (s, { a, b, defaults, ifRevision: rev }) => {
      let sectors: number[] = [];
      return op(
        s,
        "vertex",
        [a, b],
        rev,
        "split sector",
        (r) => take((out) => (sectors = out.sectors), connectVertices(r, a, b, { ...s.prefs().defaults, ...defaults })),
        () => ({ newSectors: sectors }),
      );
    },
  }),

  // ------------------------------------------------------------ linedefs
  tool({
    name: "split_linedefs",
    title: "Split linedefs",
    description: "Add a vertex in the middle of each linedef (X).",
    input: { linedefs: atLeast(1), ifRevision },
    edits: true,
    run: (s, { linedefs, ifRevision: rev }) => {
      let vertices: number[] = [];
      return op(s, "linedef", linedefs, rev, "split linedefs", (r) => take((out) => (vertices = out.vertices), splitLinedefs(r, linedefs)), () => ({ newVertices: vertices }));
    },
  }),
  tool({
    name: "split_linedefs_and_sector",
    title: "Split linedefs and sector",
    description: "Split two linedefs of the same sector at their middles and join the new vertices, dividing the sector.",
    input: { a: index, b: index, defaults: drawDefaults, ifRevision },
    edits: true,
    run: (s, { a, b, defaults, ifRevision: rev }) => {
      let sectors: number[] = [];
      return op(
        s,
        "linedef",
        [a, b],
        rev,
        "split linedefs and sector",
        (r) => take((out) => (sectors = out.sectors), splitLinedefsAndSector(r, a, b, { ...s.prefs().defaults, ...defaults })),
        () => ({ newSectors: sectors }),
      );
    },
  }),
  tool({
    name: "delete_linedefs_join_sectors",
    title: "Delete linedefs and join sectors",
    description: "Remove two-sided linedefs and merge the sectors on either side.",
    input: { linedefs: atLeast(1), ifRevision },
    edits: true,
    run: (s, { linedefs, ifRevision: rev }) => op(s, "linedef", linedefs, rev, "delete linedefs and join sectors", (r) => deleteLinedefsJoinSectors(r, linedefs)),
  }),
  tool({
    name: "flip_linedefs",
    title: "Flip linedefs or swap sides",
    description: "swapVertices true: flip the linedef (Shift+F), reversing its ends and swapping its sides so each still faces its sector. false: swap the sides only.",
    input: { linedefs: atLeast(1), swapVertices: z.boolean(), ifRevision },
    edits: true,
    run: (s, { linedefs, swapVertices, ifRevision: rev }) => op(s, "linedef", linedefs, rev, swapVertices ? "flip linedefs" : "swap sides", (r) => flipLinedefs(r, linedefs, swapVertices)),
  }),
  tool({
    name: "make_sector_from_linedefs",
    title: "Make a sector from linedefs",
    description: "Give a closed loop of linedefs a new sector on the inside.",
    input: { linedefs: atLeast(1), defaults: drawDefaults, ifRevision },
    edits: true,
    run: (s, { linedefs, defaults, ifRevision: rev }) => {
      let sector = -1;
      return op(
        s,
        "linedef",
        linedefs,
        rev,
        "make sector",
        (r) => take((out) => (sector = out.sector), makeSectorFromLinedefs(r, linedefs, { ...s.prefs().defaults, ...defaults })),
        () => ({ sector }),
      );
    },
  }),
  tool({
    name: "align_textures_y",
    title: "Align textures (Y offset)",
    description: "roomedit's AlignTexturesY: match the y offsets along the linedefs.",
    input: { linedefs: atLeast(1), ifRevision },
    edits: true,
    run: (s, { linedefs, ifRevision: rev }) => op(s, "linedef", linedefs, rev, "align y offsets", (r) => alignTexturesY(r, linedefs)),
  }),
  tool({
    name: "align_textures_x",
    title: "Align textures (X offset)",
    description:
      "roomedit's AlignTexturesX: x offsets run on along a connected chain of linedefs (in order), wrapping at the texture's width. With loop, give one linedef and the whole closed loop from it is aligned.",
    input: {
      linedefs: atLeast(1),
      side: z.enum(["front", "back"]).optional(),
      part: z.enum(["normal", "above", "below"]).optional(),
      offset: z.number().int().min(0).optional(),
      loop: z.boolean().optional(),
      textureWidth: z.number().int().min(1).optional().describe("Override the width in editor units (otherwise read from the texture library)"),
      ifRevision,
    },
    edits: true,
    run: async (s, a) => {
      const room = s.room();
      needIndices(room, "linedef", a.linedefs);
      const chain = a.loop ? loopFrom(room, a.linedefs[0]!) : a.linedefs;
      const front = (a.side ?? "front") === "front";
      const part = a.part ?? "normal";
      const first = room.linedefs[chain[0]!]!;
      const tex = (front ? first.front : first.back)?.[part];
      const width = a.textureWidth ?? (tex ? ((await textureSize(s, tex))?.editorWidth ?? null) : null);
      return op(s, "linedef", chain, a.ifRevision, "align x offsets", (r) => alignTexturesX(r, chain, { front, part, initialOffset: a.offset ?? 0, textureWidth: () => width }), () => ({ chain, textureWidth: width }));
    },
  }),

  // ------------------------------------------------------------ sectors
  tool({
    name: "merge_sectors",
    title: "Merge sectors",
    description: "Merge sectors into the first one given. The survivor's index can shift down; the result says where it is.",
    input: { sectors: atLeast(2), ifRevision },
    edits: true,
    run: (s, { sectors, ifRevision: rev }) => op(s, "sector", sectors, rev, "merge sectors", (r) => mergeSectors(r, sectors), () => ({ sector: sectors[0]! - sectors.filter((x) => x < sectors[0]!).length })),
  }),
  tool({
    name: "make_door",
    title: "Make a door",
    description: "Make a sector a door, adapted to Meridian: closed (ceiling down to the floor), with a server id for Kod's SetSector to open it.",
    input: { sector: index, ifRevision },
    edits: true,
    run: (s, { sector, ifRevision: rev }) => op(s, "sector", [sector], rev, "make door", (r) => makeDoor(r, sector), () => ({ serverId: s.room().sectors[sector]?.serverId })),
  }),
  tool({
    name: "make_lift",
    title: "Make a lift",
    description: "Make a sector a lift, with a server id for Kod to move it.",
    input: { sector: index, ifRevision },
    edits: true,
    run: (s, { sector, ifRevision: rev }) => op(s, "sector", [sector], rev, "make lift", (r) => makeLift(r, sector), () => ({ serverId: s.room().sectors[sector]?.serverId })),
  }),
  tool({
    name: "distribute_heights",
    title: "Distribute heights",
    description: "Even out floor or ceiling heights between the first and last of three or more sectors, in the order given (stairs).",
    input: { sectors: atLeast(3), which: z.enum(["floor", "ceiling"]), ifRevision },
    edits: true,
    run: (s, { sectors, which, ifRevision: rev }) => op(s, "sector", sectors, rev, `distribute ${which} heights`, (r) => distributeHeights(r, sectors, which)),
  }),
  tool({
    name: "free_server_id",
    title: "Give sectors free server ids",
    description: "Give each sector without a server id an unused one, for Kod to refer to.",
    input: { sectors: atLeast(1), ifRevision },
    edits: true,
    run: (s, { sectors, ifRevision: rev }) =>
      op(
        s,
        "sector",
        sectors,
        rev,
        "assign server ids",
        (r) => sectors.reduce((acc, i) => ({ ...acc, sectors: acc.sectors.map((sec, j) => (j === i && sec.serverId === 0 ? { ...sec, serverId: freeSectorServerId(acc) } : sec)) }), r),
        () => ({ serverIds: sectors.map((i) => ({ sector: i, serverId: s.room().sectors[i]!.serverId })) }),
      ),
  }),
  tool({
    name: "add_slope",
    title: "Add a slope",
    description: "Turn on a sloped floor or ceiling resting on three of the sector's vertices at its current height. Then set the points' heights with set_slope.",
    input: { sector: index, which: z.enum(["floor", "ceiling"]), ifRevision },
    edits: true,
    run: (s, { sector, which, ifRevision: rev }) =>
      op(s, "sector", [sector], rev, `add ${which} slope`, (r) => addSlope(r, sector, which === "floor"), () => ({ slope: s.room().sectors[sector]?.[which === "floor" ? "floorSlope" : "ceilingSlope"] })),
  }),

  // ------------------------------------------------------------ any kind
  tool({
    name: "delete_items",
    title: "Delete",
    description:
      "Delete items with roomedit's cascades: a vertex takes its linedefs, a linedef its now-unused vertices, a sector the sides facing it. Indices after deleted items shift down: read again before using old indices. Things 0 and 1 are the room-box corners; deleting them needs allowCorners.",
    input: { kind, indices, allowCorners: z.boolean().optional(), ifRevision },
    edits: true,
    annotations: { destructiveHint: true },
    run: (s, { kind: k, indices: list, allowCorners, ifRevision: rev }) => {
      if (k === "thing" && list.some((i) => i < 2) && !allowCorners) throw new OpError("Things 0 and 1 are the room-box corners: they set the room's size and Kod origin, and Server 104 needs exactly two. Pass allowCorners to delete them anyway.");
      return op(s, k, list, rev, `delete ${list.length} ${k}(s)`, (r) => deleteItems(r, k, list));
    },
  }),
  tool({
    name: "move_items",
    title: "Move",
    description: "Move items by dx, dy (a sector or linedef moves its vertices). With autoMerge (the default, as a drag does), moved vertices dropped on a vertex merge with it, and on a wall split it.",
    input: { kind, indices, dx: z.number(), dy: z.number(), autoMerge: z.boolean().optional(), ifRevision },
    edits: true,
    run: (s, { kind: k, indices: list, dx, dy, autoMerge: merge, ifRevision: rev }) =>
      op(s, k, list, rev, `move ${k}s`, (r) => {
        const moved = moveItems(r, k, list, Math.round(dx), Math.round(dy));
        if (k === "thing" || merge === false) return moved;
        return autoMerge(
          moved,
          verticesOf(r, k, list).map((v) => moved.vertices[v]!),
        );
      }),
  }),
  tool({
    name: "rotate_scale",
    title: "Rotate and scale",
    description: "Rotate (degrees, counter-clockwise) and scale (1 = same size) about the items' centre. snap8 rounds vertices to 8 units as roomedit does (default true).",
    input: { kind, indices, degrees: z.number(), scale: z.number().positive().optional(), snap8: z.boolean().optional(), ifRevision },
    edits: true,
    run: (s, { kind: k, indices: list, degrees, scale, snap8, ifRevision: rev }) => op(s, k, list, rev, "rotate and scale", (r) => rotateScale(r, k, list, degrees, scale ?? 1, snap8 ?? true)),
  }),
  tool({
    name: "mirror",
    title: "Mirror",
    description: "Mirror linedefs, sectors or things left–right (horizontal) or top–bottom about their centre.",
    input: { kind: z.enum(["linedef", "sector", "thing"]), indices, horizontal: z.boolean(), ifRevision },
    edits: true,
    run: (s, { kind: k, indices: list, horizontal, ifRevision: rev }) => op(s, k, list, rev, horizontal ? "mirror left-right" : "mirror top-bottom", (r) => mirror(r, k, list, horizontal)),
  }),
  tool({
    name: "duplicate_items",
    title: "Duplicate",
    description: "Copy items and paste the copy offset by dx, dy (Copy, then Paste). Copying linedefs or sectors brings their vertices and sectors along. Returns the new items.",
    input: { kind, indices, dx: z.number(), dy: z.number(), ifRevision },
    edits: true,
    run: (s, { kind: k, indices: list, dx, dy, ifRevision: rev }) => {
      let made: { kind: string; indices: number[] } | null = null;
      return op(
        s,
        k,
        list,
        rev,
        "duplicate",
        (r) => {
          const out = paste(r, copySelection(r, k, list), Math.round(dx), Math.round(dy));
          made = { kind: out.kind, indices: out.indices };
          return out.room;
        },
        () => ({ created: made }),
      );
    },
  }),
];
