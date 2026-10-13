// Room source → .roo for one target, ported from roomedit/source/save.cpp
// SaveLevelData and its helpers (AddWallsFromLinedef, FindSidedef,
// SetWallHeights, NumberNodes, SaveNodes, SaveClientWalls,
// SaveRoomeditWalls, ComputeSlopeInfo, SaveThings, SaveServerInfo).

import {
  BLAK_FACTOR,
  SF,
  WF,
  writeRoo,
  type BspNode,
  type ClientWall,
  type EditorWall,
  type RooFile,
  type Sector,
  type Sidedef,
  type Slope,
  type TargetProfile,
  type Things,
} from "@meridian-editor/roo";
import { buildTree, cRound, type BuildNode, type BuildWall } from "./bsp.ts";
import { computeGrids } from "./grids.ts";
import { computeSlope, type SlopeFrame } from "./slope.ts";
import { validateSource, type Diagnostic, type RoomSource, type SourceSector, type SourceSide, type SourceSlope } from "./source.ts";

export interface CompileResult {
  file: RooFile;
  bytes: Uint8Array;
  /** Validation warnings and anything roomedit would have logged while building. */
  diagnostics: Diagnostic[];
  /**
   * Editor coordinates of the client origin (the room box's left and top).
   * Client (x, y) maps back to editor (origin.x + x / 16, origin.y - y / 16).
   */
  origin: { x: number; y: number };
}

export class CompileError extends Error {
  readonly diagnostics: Diagnostic[];
  constructor(diagnostics: Diagnostic[]) {
    const errors = diagnostics.filter((d) => d.severity === "error");
    super(`room source has ${errors.length} error(s):\n${errors.map((d) => `  ${d.message}`).join("\n")}`);
    this.diagnostics = diagnostics;
  }
}

/** C SHORT / USHORT conversions. */
const toShort = (v: number): number => (v << 16) >> 16;
const toUShort = (v: number): number => v & 0xffff;

export function compileRoom(src: RoomSource, profile: TargetProfile): CompileResult {
  const diagnostics = validateSource(src, profile);
  if (diagnostics.some((d) => d.severity === "error")) throw new CompileError(diagnostics);
  if (src.vertices.length === 0) throw new CompileError([{ severity: "error", message: "room has no vertices" }]);

  // FindRoomBoundary
  let mapMinX = Infinity;
  let mapMinY = Infinity;
  let mapMaxX = -Infinity;
  let mapMaxY = -Infinity;
  for (const [x, y] of src.vertices) {
    mapMinX = Math.min(mapMinX, x);
    mapMinY = Math.min(mapMinY, y);
    mapMaxX = Math.max(mapMaxX, x);
    mapMaxY = Math.max(mapMaxY, y);
  }

  // GetRoomSubRect: the first two things set the apparent room size.
  let trueMinX: number;
  let trueMinY: number;
  let trueMaxX: number;
  let trueMaxY: number;
  if (src.things.length >= 2) {
    const [t0, t1] = src.things as [{ x: number; y: number }, { x: number; y: number }];
    const left = Math.min(t0.x, t1.x);
    const right = Math.max(t0.x, t1.x);
    const top = Math.max(t0.y, t1.y);
    const bottom = Math.min(t0.y, t1.y);
    trueMinX = (mapMinX - left) * BLAK_FACTOR;
    trueMinY = (top - mapMaxY) * BLAK_FACTOR;
    trueMaxX = (mapMaxX - left) * BLAK_FACTOR;
    trueMaxY = (top - mapMinY) * BLAK_FACTOR;
    mapMinX = toShort(left);
    mapMinY = toShort(bottom);
    mapMaxX = toShort(right);
    mapMaxY = toShort(top);
  } else {
    trueMinX = 0;
    trueMinY = 0;
    trueMaxX = (mapMaxX - mapMinX) * BLAK_FACTOR;
    trueMaxY = (mapMaxY - mapMinY) * BLAK_FACTOR;
  }
  const width = (mapMaxX - mapMinX) * BLAK_FACTOR;
  const height = (mapMaxY - mapMinY) * BLAK_FACTOR;

  // FindSidedef: file sidedefs are shared between identical sides, numbered in order of first use.
  const sidedefs: Sidedef[] = [];
  const sidedefIndex = new Map<string, number>();
  const findSidedef = (side: SourceSide): number => {
    const key = `${side.serverId},${side.above},${side.below},${side.normal},${side.flags | 0},${side.animateSpeed}`;
    let num = sidedefIndex.get(key);
    if (num === undefined) {
      sidedefs.push({ id: side.serverId, normal: side.normal, above: side.above, below: side.below, flags: side.flags | 0, animateSpeed: side.animateSpeed });
      num = sidedefs.length;
      sidedefIndex.set(key, num);
    }
    return num;
  };

  // AddWallsFromLinedef: roomedit prepends each wall, so the list runs last linedef first.
  const fileSidedef1: number[] = [];
  const fileSidedef2: number[] = [];
  const prepended: BuildWall[] = [];
  src.linedefs.forEach((l, num) => {
    fileSidedef1[num] = 0;
    fileSidedef2[num] = 0;
    const [sx, sy] = src.vertices[l.start]!;
    const [ex, ey] = src.vertices[l.end]!;
    if (sx === ex && sy === ey) return;

    const wall: BuildWall = {
      x0: (sx - mapMinX) * BLAK_FACTOR,
      y0: (mapMaxY - sy) * BLAK_FACTOR,
      x1: (ex - mapMinX) * BLAK_FACTOR,
      y1: (mapMaxY - ey) * BLAK_FACTOR,
      length: toUShort(cRound(Math.hypot(toShort(ex - sx), toShort(ey - sy)))),
      posSidedef: 0,
      negSidedef: 0,
      posSector: -1,
      negSector: -1,
      posXOffset: 0,
      negXOffset: 0,
      posYOffset: 0,
      negYOffset: 0,
      posBackwards: !!(l.front && l.front.flags & WF.BACKWARDS),
      negBackwards: !!(l.back && l.back.flags & WF.BACKWARDS),
      z0: 0,
      z1: 0,
      z2: 0,
      z3: 0,
      linedef: num,
    };
    if (l.front) {
      wall.posSector = l.front.sector;
      wall.posXOffset = l.front.xOffset;
      wall.posYOffset = l.front.yOffset;
      wall.posSidedef = fileSidedef1[num] = findSidedef(l.front);
    }
    if (l.back) {
      wall.negSector = l.back.sector;
      wall.negXOffset = l.back.xOffset;
      wall.negYOffset = l.back.yOffset;
      wall.negSidedef = fileSidedef2[num] = findSidedef(l.back);
    }
    setWallHeights(wall, src.sectors);
    prepended.push(wall);
  });
  const walls = prepended.reverse();

  const built = buildTree(walls, trueMinX, trueMinY, trueMaxX, trueMaxY, { flipSwapsYOffsets: !src.compat?.flipKeepsYOffsets });
  for (const message of built.log) diagnostics.push({ severity: "warning", message: `BSP: ${message}` });

  const { nodes, clientWalls } = flattenTree(built.tree);
  if (built.wallCount !== clientWalls.length) {
    diagnostics.push({
      severity: "warning",
      message: `BSP: roomedit would declare ${built.wallCount} client walls but write ${clientWalls.length}; this room needs fixing`,
    });
  }

  const mirror = !!src.compat?.mirrorMissingBackOffsets;
  const editorWalls: EditorWall[] = src.linedefs.map((l, num) => {
    const [sx, sy] = src.vertices[l.start]!;
    const [ex, ey] = src.vertices[l.end]!;
    const back = l.back ?? (mirror ? l.front : null);
    return {
      sidedef1: l.front ? fileSidedef1[num]! : 0,
      sidedef2: l.back ? fileSidedef2[num]! : 0,
      xOffset1: l.front?.xOffset ?? 0,
      xOffset2: back?.xOffset ?? 0,
      yOffset1: l.front?.yOffset ?? 0,
      yOffset2: back?.yOffset ?? 0,
      sector1: l.front ? l.front.sector : -1,
      sector2: l.back ? l.back.sector : -1,
      x0: sx,
      y0: sy,
      x1: ex,
      y1: ey,
    };
  });

  const frame = { mapMinX, mapMaxY };
  const sectors: Sector[] = src.sectors.map((s, i) => compileSector(s, i, frame, !!src.compat?.floatSlopes));

  const file: RooFile = {
    version: profile.version,
    security: 0,
    width,
    height,
    nodes,
    clientWalls,
    editorWalls,
    sidedefs,
    sectors,
    things: compileThings(src),
    roomId: src.roomId,
    server: null,
    serverExtra: new Uint8Array(0),
  };

  if (profile.version < 14) {
    file.server = computeGrids(
      built.tree,
      {
        sidedef: (num) => sidedefs[num - 1],
        sector: (num) => src.sectors[num],
      },
      width,
      height,
    );
  }

  const bytes = writeRoo(file);
  file.security = new DataView(bytes.buffer, bytes.byteOffset).getInt32(8, true);
  return { file, bytes, diagnostics, origin: { x: mapMinX, y: mapMaxY } };
}

function setWallHeights(wall: BuildWall, sectors: SourceSector[]): void {
  const s1 = wall.posSector !== -1 ? sectors[wall.posSector] : undefined;
  const s2 = wall.negSector !== -1 ? sectors[wall.negSector] : undefined;
  if (!s1 && !s2) {
    wall.z0 = wall.z1 = 0;
    wall.z2 = wall.z3 = 64;
  } else if (!s1) {
    wall.z0 = wall.z1 = s2!.floorHeight;
    wall.z2 = wall.z3 = s2!.ceilingHeight;
  } else if (!s2) {
    wall.z0 = wall.z1 = s1.floorHeight;
    wall.z2 = wall.z3 = s1.ceilingHeight;
  } else {
    wall.z0 = Math.min(s1.floorHeight, s2.floorHeight);
    wall.z1 = Math.max(s1.floorHeight, s2.floorHeight);
    wall.z2 = Math.min(s1.ceilingHeight, s2.ceilingHeight);
    wall.z3 = Math.max(s1.ceilingHeight, s2.ceilingHeight);
  }
}

/** NumberNodes + SaveNodes + SaveClientWalls: pre-order, node then + subtree then − subtree. */
function flattenTree(tree: BuildNode | null): { nodes: BspNode[]; clientWalls: ClientWall[] } {
  const nodeNum = new Map<BuildNode, number>();
  const wallNum = new Map<BuildWall, number>();
  const order: BuildNode[] = [];
  const number = (node: BuildNode | null): void => {
    if (!node) return;
    order.push(node);
    nodeNum.set(node, order.length);
    if (node.type === "internal") {
      for (const w of node.walls) wallNum.set(w, wallNum.size + 1);
      number(node.pos);
      number(node.neg);
    }
  };
  number(tree);

  const nodes: BspNode[] = [];
  const clientWalls: ClientWall[] = [];
  for (const node of order) {
    if (node.type === "leaf") {
      nodes.push({ type: "leaf", bbox: { ...node.bbox }, sector: node.sector + 1, points: node.poly.slice(0, node.npts).map((p) => ({ x: p.x, y: p.y })) });
      continue;
    }
    nodes.push({
      type: "internal",
      bbox: { ...node.bbox },
      a: node.a,
      b: node.b,
      c: node.c,
      posChild: node.pos ? nodeNum.get(node.pos)! : 0,
      negChild: node.neg ? nodeNum.get(node.neg)! : 0,
      firstWall: node.walls.length ? wallNum.get(node.walls[0]!)! : 0,
    });
    node.walls.forEach((w, i) => {
      const next = node.walls[i + 1];
      clientWalls.push({
        next: next ? wallNum.get(next)! : 0,
        posSidedef: w.posSidedef,
        negSidedef: w.negSidedef,
        x0: w.x0,
        y0: w.y0,
        x1: w.x1,
        y1: w.y1,
        length: w.length,
        posXOffset: w.posXOffset,
        negXOffset: w.negXOffset,
        posYOffset: w.posYOffset,
        negYOffset: w.negYOffset,
        posSector: w.posSector + 1,
        negSector: w.negSector + 1,
      });
    });
  }
  return { nodes, clientWalls };
}

function compileSector(s: SourceSector, index: number, frame: SlopeFrame, float: boolean): Sector {
  const slope = (src: SourceSlope | null, floor: boolean): Slope => {
    const out = src && computeSlope(src, floor, frame, float);
    if (!out) throw new CompileError([{ severity: "error", message: `sector ${index} ${floor ? "floor" : "ceiling"} slope points are collinear` }]);
    return out;
  };
  return {
    userId: s.serverId,
    floorTexture: s.floorTexture,
    ceilingTexture: s.ceilingTexture,
    xOffset: s.xOffset,
    yOffset: s.yOffset,
    floorHeight: s.floorHeight,
    ceilingHeight: s.ceilingHeight,
    light: s.light,
    flags: s.flags | 0,
    animateSpeed: s.animateSpeed,
    floorSlope: s.flags & SF.SLOPED_FLOOR ? slope(s.floorSlope, true) : null,
    ceilingSlope: s.flags & SF.SLOPED_CEILING ? slope(s.ceilingSlope, false) : null,
  };
}

function compileThings(src: RoomSource): Things {
  if (src.things.length <= 2) return { format: "corners", things: src.things.map((t) => ({ x: t.x, y: t.y })) };
  return {
    format: "full",
    things: src.things.map((t) => {
      // strncpy(comments, comment, 63); comments[63] = 0
      const comment = new Uint8Array(64);
      const text = t.comment ?? "";
      for (let i = 0; i < Math.min(63, text.length); i++) comment[i] = text.charCodeAt(i) & 0xff;
      return {
        type: t.type ?? 0,
        angle: t.angle ?? 0,
        x: t.x,
        y: t.y,
        when: t.when ?? 0,
        xExit: t.xExit ?? 0,
        yExit: t.yExit ?? 0,
        flags: t.flags ?? 0,
        comment,
      };
    }),
  };
}
