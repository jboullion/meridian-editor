// The room the way the client holds it after loading (clientd3d/bspload.c
// BSPRooFileLoad + RoomSwizzle + SetWallHeights + LoadSlopeInfo), built from
// a compiled RooFile so the 3D preview can use the client's own geometry code.
//
// Ported from meridian-browser packages/formats/src/roo.ts (GPL-2.0, same
// authors), which parses v14+ bytes; this takes an already-read RooFile of any
// version. Keep the two in step.

import { FINENESS, type RooFile, type Slope as FileSlope } from "@meridian-editor/roo";

export const SF = {
  DEPTH_MASK: 0x3,
  SCROLL_FLOOR: 0x80,
  SCROLL_CEILING: 0x100,
} as const;

export const WF = {
  BACKWARDS: 0x1,
  TRANSPARENT: 0x2,
  PASSABLE: 0x4,
  ABOVE_BOTTOMUP: 0x40,
  BELOW_TOPDOWN: 0x80,
  NORMAL_TOPDOWN: 0x100,
  NO_VTILE: 0x200,
} as const;

/** Bowtie bits (bsp.h): a two-sided wall whose upper/lower edge crosses itself. */
export const BT = {
  BELOW_POS: 0x1,
  BELOW_NEG: 0x2,
  ABOVE_POS: 0x4,
  ABOVE_NEG: 0x8,
} as const;

interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface Slope {
  a: number;
  b: number;
  c: number;
  d: number;
  /** Texture origin, and the ends of the texture's u and v axes from it (one square long). */
  p0: Vec3;
  p1: Vec3;
  p2: Vec3;
  angle: number;
}

export interface Sector {
  floorType: number;
  ceilingType: number;
  /** Texture origin in client fine units. */
  tx: number;
  ty: number;
  floorHeight: number;
  ceilingHeight: number;
  light: number;
  flags: number;
  animateSpeed: number;
  slopedFloor: Slope | null;
  slopedCeiling: Slope | null;
}

export interface Sidedef {
  normalType: number;
  aboveType: number;
  belowType: number;
  flags: number;
  animateSpeed: number;
}

export interface Wall {
  posSidedef: number;
  negSidedef: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  length: number;
  posXOffset: number;
  negXOffset: number;
  posYOffset: number;
  negYOffset: number;
  posSector: number;
  negSector: number;
  z0: number;
  z1: number;
  z2: number;
  z3: number;
  zz0: number;
  zz1: number;
  zz2: number;
  zz3: number;
  z0Neg: number;
  z1Neg: number;
  zz0Neg: number;
  zz1Neg: number;
  bowtie: number;
  separator: { a: number; b: number; c: number };
}

export interface BspInternal {
  type: "internal";
  bbox: [number, number, number, number];
  /** The splitting plane as stored: a x + b y + c = 0. */
  a: number;
  b: number;
  c: number;
  /** Node index + 1; 0 = none. */
  pos: number;
  neg: number;
  walls: number[];
}

export interface BspLeaf {
  type: "leaf";
  bbox: [number, number, number, number];
  /** 1-based sector. */
  sector: number;
  points: { x: number; y: number }[];
}

export interface Room {
  nodes: (BspInternal | BspLeaf)[];
  walls: Wall[];
  sidedefs: Sidedef[];
  sectors: Sector[];
  /** The room box from the two corner things, client fine units (LoadThings). */
  thingsBox: { maxX: number; maxY: number };
}

/** BSPRooFileLoad's view of a compiled room. */
export function toClientRoom(file: RooFile): Room {
  const sectors: Sector[] = file.sectors.map((s) => ({
    floorType: s.floorTexture,
    ceilingType: s.ceilingTexture,
    // The client reads these as WORDs and scales them (FinenessKodToClient).
    tx: (s.xOffset & 0xffff) << 4,
    ty: (s.yOffset & 0xffff) << 4,
    floorHeight: (s.floorHeight & 0xffff) << 4,
    ceilingHeight: (s.ceilingHeight & 0xffff) << 4,
    light: s.light,
    flags: s.flags,
    animateSpeed: s.animateSpeed,
    slopedFloor: s.floorSlope && slope(s.floorSlope),
    slopedCeiling: s.ceilingSlope && slope(s.ceilingSlope),
  }));
  const sidedefs: Sidedef[] = file.sidedefs.map((s) => ({ normalType: s.normal, aboveType: s.above, belowType: s.below, flags: s.flags, animateSpeed: s.animateSpeed }));
  const walls: Wall[] = file.clientWalls.map((w) => ({
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
    posSector: w.posSector,
    negSector: w.negSector,
    z0: 0,
    z1: 0,
    z2: 0,
    z3: 0,
    zz0: 0,
    zz1: 0,
    zz2: 0,
    zz3: 0,
    z0Neg: 0,
    z1Neg: 0,
    zz0Neg: 0,
    zz1Neg: 0,
    bowtie: 0,
    separator: { a: 0, b: 0, c: 0 },
  }));

  // RoomSwizzle: wall lists per node, normalised separators, wall heights.
  const nodes = file.nodes.map((n): BspInternal | BspLeaf => {
    const bbox: [number, number, number, number] = [n.bbox.x0, n.bbox.y0, n.bbox.x1, n.bbox.y1];
    if (n.type === "leaf") return { type: "leaf", bbox, sector: n.sector, points: n.points };
    const node: BspInternal = { type: "internal", bbox, a: n.a, b: n.b, c: n.c, pos: n.posChild, neg: n.negChild, walls: [] };
    const first = n.firstWall;
    const w0 = first ? walls[first - 1] : undefined;
    if (!w0) return node;
    let a = n.a * FINENESS;
    let b = n.b * FINENESS;
    const norm = Math.hypot(a, b) || 1;
    a = (a * FINENESS) / norm;
    b = (b * FINENESS) / norm;
    const c = -(a * w0.x1 + b * w0.y1 + (a * w0.x0 + b * w0.y0)) / 2;
    // The swizzle replaces the node's own plane with the normalised one (1024 long).
    Object.assign(node, { a, b, c });
    const seen = new Set<number>();
    for (let w = first; w !== 0 && !seen.has(w) && w <= walls.length; w = file.clientWalls[w - 1]!.next) {
      seen.add(w);
      node.walls.push(w - 1);
      const wall = walls[w - 1]!;
      wall.separator = { a, b, c };
      setWallHeights(wall, sectors);
    }
    return node;
  });
  // Things (LoadThings): Kod fine units, 64 a square.
  const [t0, t1] = file.things.things;
  const thingsBox = t0 && t1 ? { maxX: Math.abs(t1.x - t0.x) * 16, maxY: Math.abs(t1.y - t0.y) * 16 } : { maxX: 0, maxY: 0 };
  return { nodes, walls, sidedefs, sectors, thingsBox };
}

/** drawbsp.c BSPFindLeafByPoint: on a plane, take the + child if there is one. */
export function leafAt(room: Room, x: number, y: number): BspLeaf | null {
  let idx = room.nodes.length ? 0 : -1;
  while (idx >= 0) {
    const n = room.nodes[idx]!;
    if (n.type === "leaf") return n;
    const side = n.a * x + n.b * y + n.c;
    const next = side === 0 ? n.pos || n.neg : side > 0 ? n.pos : n.neg;
    if (!next) return null;
    idx = next - 1;
  }
  return null;
}

/** LoadSlopeInfo: the plane, and the texture's axes from its origin and angle. */
function slope(s: FileSlope): Slope {
  let { a, b, c, d } = s;
  if (c === 0) {
    a = 0;
    b = 0;
    c = 1024;
    d = 0;
  }
  const p0 = { x: s.x, y: s.y, z: f32((-a * s.x - b * s.y - d) / c) };
  const [v1, v2] = slopeTextureAxes(a, b, c, s.angle);
  const add = (v: Vec3): Vec3 => ({ x: f32(p0.x + v.x), y: f32(p0.y + v.y), z: f32(p0.z + v.z) });
  return { a, b, c, d, p0, p1: add(v1), p2: add(v2), angle: s.angle };
}

// The client's fixed-point helpers (fixed.c, 8 fractional bits), as LoadSlopeInfo uses them.
const f32 = Math.fround;
const toLong = (v: number): number => Math.trunc(v) | 0;
const fpMul = (m1: number, m2: number): number => Number((BigInt(toLong(m1)) * BigInt(toLong(m2)) + 128n) >> 8n) | 0;
const fpSquare = (x: number): number => fpMul(x, x);
const mulDiv = (value: number, mulBy: number, divBy: number): number => Number((BigInt(toLong(value)) * BigInt(toLong(mulBy))) / BigInt(toLong(divBy))) | 0;
function dbl2fp(v: number): number {
  const x = v * 256 + 0.5;
  const r = Math.round(x);
  return (Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r) | 0;
}
const fpSqrt = (x: number): number => dbl2fp(Math.sqrt(x / 256));
const v3Cross = (a: Vec3, b: Vec3): Vec3 => ({
  x: fpMul(a.y, b.z) - fpMul(a.z, b.y),
  y: fpMul(a.z, b.x) - fpMul(a.x, b.z),
  z: fpMul(a.x, b.y) - fpMul(a.y, b.x),
});
function v3Scale(v: Vec3, newLen: number): Vec3 {
  const len = fpSqrt(fpSquare(v.x) + fpSquare(v.y) + fpSquare(v.z));
  if (len === 0) return v;
  return { x: mulDiv(v.x, newLen, len), y: mulDiv(v.y, newLen, len), z: mulDiv(v.z, newLen, len) };
}
const cosTable = (angle: number): number => Math.trunc(Math.cos(((angle & 4095) * 2 * Math.PI) / 4096) * 65536);
const sinTable = (angle: number): number => Math.trunc(Math.sin(((angle & 4095) * 2 * Math.PI) / 4096) * 65536);

function slopeTextureAxes(a: number, b: number, c: number, angle: number): [Vec3, Vec3] {
  const normal = { x: a, y: b, z: c };
  const orientation = { x: cosTable(angle) >> 6, y: sinTable(angle) >> 6, z: 0 };
  const v2 = v3Scale(v3Cross(normal, orientation), FINENESS);
  const v1 = v3Scale(v3Cross(v2, normal), FINENESS);
  return [v1, v2];
}

/** drawbsp.c GetFloorHeight (x, y truncated like the C long parameters). */
export function floorHeightAt(s: Sector, x: number, y: number): number {
  if (!s.slopedFloor) return s.floorHeight;
  const p = s.slopedFloor;
  return Math.round((-p.a * Math.trunc(x) - p.b * Math.trunc(y) - p.d) / p.c);
}

export function ceilingHeightAt(s: Sector, x: number, y: number): number {
  if (!s.slopedCeiling) return s.ceilingHeight;
  const p = s.slopedCeiling;
  return Math.round((-p.a * Math.trunc(x) - p.b * Math.trunc(y) - p.d) / p.c);
}

/** bspload.c SetWallHeights (the D3D branch for bowties). */
function setWallHeights(w: Wall, sectors: Sector[]): void {
  const S1 = w.posSector ? sectors[w.posSector - 1] : undefined;
  const S2 = w.negSector ? sectors[w.negSector - 1] : undefined;
  if (!S1 && !S2) {
    w.z0 = w.z1 = 0;
    w.z2 = w.z3 = FINENESS;
    w.zz0 = w.zz1 = 0;
    w.zz2 = w.zz3 = FINENESS;
    return;
  }
  if (!S1 || !S2) {
    const S = (S1 ?? S2)!;
    w.z0 = w.z1 = floorHeightAt(S, w.x0, w.y0);
    w.z2 = w.z3 = ceilingHeightAt(S, w.x0, w.y0);
    w.zz0 = w.zz1 = floorHeightAt(S, w.x1, w.y1);
    w.zz2 = w.zz3 = ceilingHeightAt(S, w.x1, w.y1);
    return;
  }
  let a0 = floorHeightAt(S1, w.x0, w.y0);
  let b0 = floorHeightAt(S2, w.x0, w.y0);
  let a1 = floorHeightAt(S1, w.x1, w.y1);
  let b1 = floorHeightAt(S2, w.x1, w.y1);
  if (a0 > b0) {
    if (a1 >= b1) {
      w.bowtie = 0;
      w.z1 = a0;
      w.zz1 = a1;
      w.z0 = b0;
      w.zz0 = b1;
    } else {
      w.bowtie = BT.BELOW_POS;
      w.z1 = a0;
      w.zz1 = a1;
      w.z0 = b0;
      w.zz0 = a1;
      w.z1Neg = b0;
      w.zz1Neg = b1;
      w.z0Neg = b0;
      w.zz0Neg = a1;
    }
  } else if (b1 >= a1) {
    w.bowtie = 0;
    w.z1 = b0;
    w.zz1 = b1;
    w.z0 = a0;
    w.zz0 = a1;
  } else {
    w.bowtie = BT.BELOW_NEG;
    w.z1 = a0;
    w.zz1 = a1;
    w.z0 = a0;
    w.zz0 = b1;
    w.z1Neg = b0;
    w.zz1Neg = b1;
    w.z0Neg = a0;
    w.zz0Neg = b1;
  }

  a0 = ceilingHeightAt(S1, w.x0, w.y0);
  b0 = ceilingHeightAt(S2, w.x0, w.y0);
  a1 = ceilingHeightAt(S1, w.x1, w.y1);
  b1 = ceilingHeightAt(S2, w.x1, w.y1);
  if (a0 > b0) {
    if (a1 >= b1) {
      w.z3 = a0;
      w.zz3 = a1;
      w.z2 = b0;
      w.zz2 = b1;
    } else {
      w.bowtie |= BT.ABOVE_POS;
      w.z3 = a0;
      w.zz3 = b1;
      w.z2 = b0;
      w.zz2 = a1;
    }
  } else if (b1 >= a1) {
    w.z3 = b0;
    w.zz3 = b1;
    w.z2 = a0;
    w.zz2 = a1;
  } else {
    w.bowtie |= BT.ABOVE_NEG;
    w.z3 = b0;
    w.zz3 = a1;
    w.z2 = a0;
    w.zz2 = b1;
  }
}
