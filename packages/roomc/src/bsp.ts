// BSP builder, ported line by line from roomedit/source/bspmake.cpp. The
// original and Server-104 copies differ only in casts and printf formats; both
// use doubles throughout, so one port serves both targets.
//
// roomedit keeps walls in singly linked lists and prepends as it splits them.
// The order matters (BSPChooseRoot keeps the first best root), so lists here
// are arrays in list order: index 0 is the head.

export interface Pnt {
  x: number;
  y: number;
}

export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** roomedit's WallData, minus the fields nothing downstream reads. */
export interface BuildWall {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** Editor units: 64 per grid square. */
  length: number;
  /** 1-based file sidedef; 0 = none. */
  posSidedef: number;
  negSidedef: number;
  /** 0-based sector; -1 = none. */
  posSector: number;
  negSector: number;
  posXOffset: number;
  negXOffset: number;
  posYOffset: number;
  negYOffset: number;
  /** BF_POS_BACKWARDS / BF_NEG_BACKWARDS: the only linedef flags the builder reads. */
  posBackwards: boolean;
  negBackwards: boolean;
  /** Heights from the adjacent sectors (SetWallHeights), for the server grids. */
  z0: number;
  z1: number;
  z2: number;
  z3: number;
  linedef: number;
}

export interface BuildLeaf {
  type: "leaf";
  bbox: Box;
  /** Points in order; poly[npts] repeats poly[0], as in roomedit's Poly. */
  poly: Pnt[];
  npts: number;
  /** 0-based sector. A leaf built for sector -1 keeps 0, as roomedit's memset node does. */
  sector: number;
}

export interface BuildInternal {
  type: "internal";
  bbox: Box;
  a: number;
  b: number;
  c: number;
  walls: BuildWall[];
  pos: BuildNode | null;
  neg: BuildNode | null;
}

export type BuildNode = BuildLeaf | BuildInternal;

export interface BuildResult {
  tree: BuildNode | null;
  /** roomedit's num_walls counter, which becomes the client wall count. */
  wallCount: number;
  /** Problems roomedit would have logged with LogError. */
  log: string[];
}

const abs = (x: number): number => (x > 0 ? x : -x);
const sgnDouble = (x: number): number => (x <= 0.001 && x >= -0.001 ? 0 : x > 0.001 ? 1 : -1);
const almostEqual = (a: number, b: number): boolean => a - b <= 0.0001 && a - b >= -0.0001;
/** C round(): halves away from zero. */
export const cRound = (x: number): number => (x < 0 ? -Math.round(-x) : Math.round(x));

function gcd(a: number, b: number): number {
  if (a < 1.0 && a > -1.0) return abs(b);
  a = abs(a);
  b = abs(b);
  while (b > 1.0) {
    const temp = b;
    b = a / b;
    a = temp;
  }
  return a;
}

function reduce(a: number, b: number): [number, number] {
  const d = gcd(a, b);
  if (d <= 0.001 && d >= -0.001) return [a, b];
  return [a / d, b / d];
}

function lineFromPoints(x0: number, y0: number, x1: number, y1: number): [number, number, number] {
  const [dx, dy] = reduce(x1 - x0, y1 - y0);
  const a = -dy;
  const b = dx;
  const c = -(a * x0 + b * y0);
  return [a, b, c];
}

export function lineFromWall(w: { x0: number; y0: number; x1: number; y1: number }): [number, number, number] {
  return lineFromPoints(w.x0, w.y0, w.x1, w.y1);
}

function wallLength(w: BuildWall): number {
  return Math.hypot((w.x1 - w.x0) / 16, (w.y1 - w.y0) / 16);
}

const Intersection = {
  None: 0,
  Coincide: 1,
  FirstEndpoint: 2,
  SecondEndpoint: 3,
  Middle: 4,
} as const;
type Intersection = (typeof Intersection)[keyof typeof Intersection];

function wallIntersection(
  wall1: { x0: number; y0: number; x1: number; y1: number },
  wall2: { x0: number; y0: number; x1: number; y1: number },
): [Intersection, number, number] {
  const [a, b, c] = lineFromWall(wall1);
  const { x0, y0, x1, y1 } = wall2;
  const side0 = a * x0 + b * y0 + c;
  const side1 = a * x1 + b * y1 + c;

  if (almostEqual(side0, 0.0) && almostEqual(side1, 0.0)) return [Intersection.Coincide, 0, 0];
  if (almostEqual(side0, 0.0)) return [Intersection.FirstEndpoint, x0, y0];
  if (almostEqual(side1, 0.0)) return [Intersection.SecondEndpoint, x1, y1];
  if ((side0 > 0.0 && side1 > 0.0) || (side0 < 0.0 && side1 < 0.0)) return [Intersection.None, 0, 0];

  let num: number;
  let denom: number;
  if (side0 > 0.0) {
    num = side0;
    denom = side0 - side1;
  } else {
    num = -side0;
    denom = side1 - side0;
  }
  const dx = x1 - x0;
  const dy = y1 - y0;
  return [Intersection.Middle, x0 + num * (dx / denom), y0 + num * (dy / denom)];
}

function chooseRoot(walls: BuildWall[]): BuildWall {
  let bestRoot: BuildWall | null = null;
  let bestCount = -1;
  let bestSplits = 999999;

  for (const root of walls) {
    let pos = 0;
    let neg = 0;
    let splits = 0;
    const [a, b, c] = lineFromWall(root);

    for (const wall of walls) {
      const side0 = sgnDouble(a * wall.x0 + b * wall.y0 + c);
      const side1 = sgnDouble(a * wall.x1 + b * wall.y1 + c);
      if (side0 * side1 >= 0) {
        if (almostEqual(side0, 0.0) && almostEqual(side1, 0.0)) continue;
        if (side0 > 0.0 || side1 > 0.0) {
          pos++;
          continue;
        }
        neg++;
        continue;
      }
      pos++;
      neg++;
      splits++;
    }

    const maxCount = Math.max(pos, neg);
    if (maxCount < bestCount || (maxCount === bestCount && splits < bestSplits) || bestCount === -1) {
      bestCount = maxCount;
      bestRoot = root;
      bestSplits = splits;
    }
  }
  return bestRoot!;
}

function updateSplit(wall1: BuildWall, wall2: BuildWall): void {
  wall1.length = wallLength(wall1);
  wall2.length = wallLength(wall2);

  if (wall1.posBackwards) wall1.posXOffset += cRound(wall2.length);
  else wall2.posXOffset += cRound(wall1.length);

  // Backwards, because the client exchanges vertices of negative walls.
  if (wall1.negBackwards) wall2.negXOffset += cRound(wall1.length);
  else wall1.negXOffset += cRound(wall2.length);
}

function flipWall(w: BuildWall, options: BuildOptions): void {
  [w.posSector, w.negSector] = [w.negSector, w.posSector];
  [w.x0, w.x1] = [w.x1, w.x0];
  [w.y0, w.y1] = [w.y1, w.y0];
  [w.posXOffset, w.negXOffset] = [w.negXOffset, w.posXOffset];
  if (options.flipSwapsYOffsets) [w.posYOffset, w.negYOffset] = [w.negYOffset, w.posYOffset];
  [w.posSidedef, w.negSidedef] = [w.negSidedef, w.posSidedef];
  [w.posBackwards, w.negBackwards] = [w.negBackwards, w.posBackwards];
}

export interface BuildOptions {
  /** Current bspmake.cpp swaps y offsets when it flips a wall; older builds didn't. */
  flipSwapsYOffsets: boolean;
}

interface Counter {
  walls: number;
  log: string[];
  options: BuildOptions;
}

function splitWalls(walls: BuildWall[], root: BuildWall, counter: Counter): { rootWalls: BuildWall[]; posWalls: BuildWall[]; negWalls: BuildWall[] } {
  // Collected in prepend order, reversed at the end.
  const rootWalls: BuildWall[] = [];
  const posWalls: BuildWall[] = [];
  const negWalls: BuildWall[] = [];

  for (const wall of walls) {
    if (wall === root) {
      rootWalls.push(wall);
      continue;
    }
    const [a, b, c] = lineFromWall(root);
    const side0 = sgnDouble(a * wall.x0 + b * wall.y0 + c);
    const side1 = sgnDouble(a * wall.x1 + b * wall.y1 + c);

    if (side0 * side1 >= 0.0) {
      if (almostEqual(side0, 0.0) && almostEqual(side1, 0.0)) {
        const [a2, b2] = lineFromWall(wall);
        if (almostEqual(a, a2) && almostEqual(b, b2)) {
          // same direction
        } else if (almostEqual(a, -a2) || almostEqual(b, -b2)) {
          flipWall(wall, counter.options);
        } else {
          counter.log.push(`walls in the same plane disagree (linedef ${wall.linedef})`);
        }
        rootWalls.push(wall);
        continue;
      }
      if (side0 > 0.0 || side1 > 0.0) posWalls.push(wall);
      else negWalls.push(wall);
      continue;
    }

    const [kind, x, y] = wallIntersection(root, wall);
    if (kind !== Intersection.Middle) {
      // roomedit drops the wall here but keeps counting it.
      counter.log.push(`wall from linedef ${wall.linedef} straddles the root but has no middle intersection; dropped`);
      continue;
    }

    counter.walls++;
    const negWall: BuildWall = { ...wall };
    if (side0 > 0.0) {
      wall.x1 = x;
      wall.y1 = y;
      negWall.x0 = x;
      negWall.y0 = y;
      updateSplit(wall, negWall);
    } else {
      wall.x0 = x;
      wall.y0 = y;
      negWall.x1 = x;
      negWall.y1 = y;
      updateSplit(negWall, wall);
    }

    if (wall.x0 === wall.x1 && wall.y0 === wall.y1) {
      counter.log.push(`split left a zero-length wall (linedef ${wall.linedef}); dropped`);
      counter.walls--;
    } else {
      posWalls.push(wall);
    }
    if (negWall.x0 === negWall.x1 && negWall.y0 === negWall.y1) {
      counter.log.push(`split left a zero-length negative wall (linedef ${negWall.linedef}); dropped`);
      counter.walls--;
    } else {
      negWalls.push(negWall);
    }
  }

  return { rootWalls: rootWalls.reverse(), posWalls: posWalls.reverse(), negWalls: negWalls.reverse() };
}

interface Poly {
  /** npts + 1 entries; the last repeats the first. */
  p: Pnt[];
  npts: number;
}

const EMPTY: Poly = { p: [], npts: 0 };

function splitPoly(poly: Poly, wall: BuildWall, counter: Counter): { pos: Poly; neg: Poly; ok: boolean } {
  const [a, b, c] = lineFromWall(wall);
  const tmp: Pnt[] = [];
  const intr: number[] = [];
  let j = 0;
  tmp[j++] = poly.p[0]!;

  for (let i = 0; i < poly.npts; i++) {
    const p0 = poly.p[i]!;
    const p1 = poly.p[i + 1]!;
    const [kind, x, y] = wallIntersection(wall, { x0: p0.x, y0: p0.y, x1: p1.x, y1: p1.y });
    switch (kind) {
      case Intersection.None:
        tmp[j++] = p1;
        break;
      case Intersection.Coincide:
        return oneSide(poly, a, b, c, counter);
      case Intersection.FirstEndpoint:
        if (intr.length < 2) intr.push(j - 1);
        else {
          counter.log.push("more than 2 intersections! (1)");
          return { pos: EMPTY, neg: EMPTY, ok: false };
        }
        tmp[j++] = p1;
        break;
      case Intersection.SecondEndpoint:
        tmp[j++] = p1;
        break;
      case Intersection.Middle:
        tmp[j] = { x, y };
        if (intr.length < 2) intr.push(j);
        else {
          counter.log.push("more than 2 intersections! (2)");
          return { pos: EMPTY, neg: EMPTY, ok: false };
        }
        j++;
        tmp[j++] = p1;
        break;
    }
  }
  const tmpNpts = j - 1;

  if (intr.length < 2) {
    counter.log.push("less than 2 intersections!");
    return { pos: EMPTY, neg: EMPTY, ok: false };
  }
  const [i0, i1] = intr as [number, number];

  const walk = (from: number, to: number): Poly => {
    const p: Pnt[] = [];
    let i = 0;
    while (true) {
      const k = (i + from) % tmpNpts;
      p[i] = tmp[k]!;
      i++;
      if (k === to) break;
    }
    p[i] = p[0]!;
    return { p, npts: i };
  };
  let pos = walk(i0, i1);
  let neg = walk(i1, i0);

  let side = 0.0;
  for (let i = 0; i < pos.npts; i++) side += a * pos.p[i]!.x + b * pos.p[i]!.y + c;
  if (side < 0.0) [pos, neg] = [neg, pos];
  return { pos, neg, ok: true };
}

function oneSide(poly: Poly, a: number, b: number, c: number, counter: Counter): { pos: Poly; neg: Poly; ok: boolean } {
  for (let i = 0; i < poly.npts; i++) {
    const side = a * poly.p[i]!.x + b * poly.p[i]!.y + c;
    if (side > 0.0) return { pos: poly, neg: EMPTY, ok: true };
    if (side < 0.0) return { pos: EMPTY, neg: poly, ok: true };
  }
  counter.log.push("all polygon points in plane!");
  return { pos: EMPTY, neg: EMPTY, ok: false };
}

function buildNode(walls: BuildWall[], poly: Poly, sector: number, counter: Counter): BuildNode | null {
  if (poly.npts === 0 || (walls.length === 0 && sector === -1)) {
    if (walls.length > 0) counter.log.push(`${walls.length} walls fell outside the room box; dropped`);
    return null;
  }
  if (walls.length === 0) {
    return { type: "leaf", bbox: { x0: 0, y0: 0, x1: 0, y1: 0 }, poly: poly.p, npts: poly.npts, sector: sector < 0 ? 0 : sector };
  }

  const root = chooseRoot(walls);
  const { rootWalls, posWalls, negWalls } = splitWalls(walls, root, counter);
  const [a, b, c] = lineFromWall(root);
  const split = splitPoly(poly, root, counter);
  if (!split.ok) counter.log.push(`problem splitting sector ${sector} with linedef ${root.linedef}`);

  const node: BuildInternal = { type: "internal", bbox: { x0: 0, y0: 0, x1: 0, y1: 0 }, a, b, c, walls: rootWalls, pos: null, neg: null };
  node.pos = buildNode(posWalls, split.pos, root.posSector, counter);
  node.neg = buildNode(negWalls, split.neg, root.negSector, counter);
  return node;
}

function findBoundingBoxes(node: BuildNode | null, counter: Counter): void {
  if (!node) return;
  if (node.type === "leaf") {
    let minx = node.poly[0]!.x;
    let maxx = minx;
    let miny = node.poly[0]!.y;
    let maxy = miny;
    for (let i = 1; i < node.npts; i++) {
      const p = node.poly[i]!;
      minx = Math.min(minx, p.x);
      miny = Math.min(miny, p.y);
      maxx = Math.max(maxx, p.x);
      maxy = Math.max(maxy, p.y);
    }
    node.bbox = { x0: minx, y0: miny, x1: maxx, y1: maxy };
    return;
  }
  findBoundingBoxes(node.pos, counter);
  findBoundingBoxes(node.neg, counter);
  if (!node.pos && !node.neg) {
    counter.log.push("internal node with no children");
    return;
  }
  if (!node.neg) node.bbox = { ...node.pos!.bbox };
  else if (!node.pos) node.bbox = { ...node.neg.bbox };
  else {
    const p = node.pos.bbox;
    const n = node.neg.bbox;
    node.bbox = { x0: Math.min(p.x0, n.x0), y0: Math.min(p.y0, n.y0), x1: Math.max(p.x1, n.x1), y1: Math.max(p.y1, n.y1) };
  }
}

/**
 * BSPBuildTree: build the tree for `walls` (in list order) inside the box
 * (minX, minY)-(maxX, maxY). Walls are modified in place, as in roomedit.
 */
export function buildTree(
  walls: BuildWall[],
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
  options: BuildOptions = { flipSwapsYOffsets: true },
): BuildResult {
  const counter: Counter = { walls: walls.length, log: [], options };
  const p: Pnt[] = [
    { x: minX, y: minY },
    { x: maxX, y: minY },
    { x: maxX, y: maxY },
    { x: minX, y: maxY },
  ];
  p.push(p[0]!);
  const tree = buildNode(walls, { p, npts: 4 }, -1, counter);
  findBoundingBoxes(tree, counter);
  return { tree, wallCount: counter.walls, log: counter.log };
}
