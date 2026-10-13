// The original server's movement and square-flag grids, ported from the
// original tree's roomedit/source/move.cpp. Server 104 writes no grids; its
// server does geometric collision from the BSP instead.
//
// move.cpp does its plane maths in C `float`, so every step here goes through
// Math.fround.

import { FINENESS } from "@meridian-editor/roo";
import type { BuildLeaf, BuildNode } from "./bsp.ts";

const MOVE_N = 0x01;
const MOVE_NE = 0x02;
const MOVE_E = 0x04;
const MOVE_SE = 0x08;
const MOVE_S = 0x10;
const MOVE_SW = 0x20;
const MOVE_W = 0x40;
const MOVE_NW = 0x80;

const SQUARE_PLAYABLE = 0x01;
const STEPS_PER_MOVE = 5;
const MAX_STEP_HEIGHT = 24;
const OBJECT_HEIGHT = 48;
/** FinenessClientToKod(n * FINENESS / 5) for depths 0-3. */
const SECTOR_DEPTHS = [0, Math.trunc(Math.trunc(FINENESS / 5) / 16), Math.trunc(Math.trunc((2 * FINENESS) / 5) / 16), Math.trunc(Math.trunc((3 * FINENESS) / 5) / 16)];

/** save.cpp min_player_distance and min_monster_distance. */
export const MIN_PLAYER_DISTANCE = FINENESS / 4;
export const MIN_MONSTER_DISTANCE = FINENESS / 16;

/** What the grid code needs from the file sidedefs and sectors. */
export interface GridContext {
  /** 1-based file sidedefs. */
  sidedef: (num: number) => { above: number; below: number; flags: number } | undefined;
  /** 0-based sector flags and heights. */
  sector: (num: number) => { flags: number; floorHeight: number; floorTexture: number } | undefined;
}

const f = Math.fround;
const abs = (x: number): number => (x > 0 ? x : -x);
const WF_PASSABLE = 0x4;

export interface Grids {
  rows: number;
  cols: number;
  playerMove: Uint8Array;
  squareFlags: Uint8Array;
  monsterMove: Uint8Array;
}

/** SaveServerInfo: width and height in client units. */
export function computeGrids(tree: BuildNode | null, ctx: GridContext, width: number, height: number): Grids {
  const rows = Math.trunc(height / FINENESS);
  const cols = Math.trunc(width / FINENESS);
  const playerMove = new Uint8Array(rows * cols);
  const squareFlags = new Uint8Array(rows * cols);
  const monsterMove = new Uint8Array(rows * cols);
  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < cols; j++) {
      playerMove[i * cols + j] = moveFlags(tree, ctx, i, j, rows, cols, MIN_PLAYER_DISTANCE);
      squareFlags[i * cols + j] = squareFlag(tree, ctx, i, j);
      monsterMove[i * cols + j] = moveFlags(tree, ctx, i, j, rows, cols, MIN_MONSTER_DISTANCE);
    }
  }
  return { rows, cols, playerMove, squareFlags, monsterMove };
}

function moveFlags(tree: BuildNode | null, ctx: GridContext, row: number, col: number, rows: number, cols: number, minDistance: number): number {
  const sx = col * FINENESS + FINENESS / 2;
  const sy = row * FINENESS + FINENESS / 2;
  const maxx = cols * FINENESS;
  const maxy = rows * FINENESS;
  const n = Math.max(0, sy - FINENESS);
  const s = Math.min(maxy, sy + FINENESS);
  const e = Math.min(maxx, sx + FINENESS);
  const w = Math.max(0, sx - FINENESS);
  const ok = (dx: number, dy: number): boolean => !tooCloseToWall(tree, ctx, sx, sy, dx, dy, minDistance);

  let b = 0;
  if (ok(sx, n)) b |= MOVE_N;
  if (ok(e, n)) b |= MOVE_NE;
  if (ok(e, sy)) b |= MOVE_E;
  if (ok(e, s)) b |= MOVE_SE;
  if (ok(sx, s)) b |= MOVE_S;
  if (ok(w, s)) b |= MOVE_SW;
  if (ok(w, sy)) b |= MOVE_W;
  if (ok(w, n)) b |= MOVE_NW;
  return b;
}

function tooCloseToWall(tree: BuildNode | null, ctx: GridContext, oldX: number, oldY: number, newX: number, newY: number, minDistance: number): boolean {
  let lastX = oldX;
  let lastY = oldY;
  for (let i = 1; i <= STEPS_PER_MOVE; i++) {
    const z = pointFloor(tree, ctx, lastX, lastY);
    const x = oldX + Math.trunc(((newX - oldX) * i) / STEPS_PER_MOVE);
    const y = oldY + Math.trunc(((newY - oldY) * i) / STEPS_PER_MOVE);
    if (checkNode(tree, ctx, lastX, lastY, x, y, z, minDistance)) return true;
    lastX = x;
    lastY = y;
  }
  return false;
}

function checkNode(node: BuildNode | null, ctx: GridContext, oldX: number, oldY: number, x: number, y: number, z: number, minDistance: number): boolean {
  if (!node || node.type === "leaf") return false;
  if (node.bbox.x0 - x > minDistance || x - node.bbox.x1 > minDistance || node.bbox.y0 - y > minDistance || y - node.bbox.y1 > minDistance) {
    return false;
  }

  const a = f(node.a);
  const b = f(node.b);
  const c = f(node.c);
  const distance = f(f(f(a * x) + f(b * y)) + c);
  const temp = f(abs(distance) / minDistance);
  if (f(temp * temp) < f(f(a * a) + f(b * b))) {
    for (const wall of node.walls) {
      const minx = Math.trunc(Math.min(wall.x0, wall.x1));
      const maxx = Math.trunc(Math.max(wall.x0, wall.x1));
      const miny = Math.trunc(Math.min(wall.y0, wall.y1));
      const maxy = Math.trunc(Math.max(wall.y0, wall.y1));
      if (!(minx - minDistance <= x && x <= maxx + minDistance && miny - minDistance <= y && y <= maxy + minDistance)) continue;

      // Moving away from a wall is allowed, if both positions are near it.
      const oldDistance = f(f(f(a * oldX) + f(b * oldY)) + c);
      if (
        abs(distance) > abs(oldDistance) &&
        minx - minDistance <= oldX &&
        oldX <= maxx + minDistance &&
        miny - minDistance <= oldY &&
        oldY <= maxy + minDistance
      ) {
        continue;
      }

      let sidedefNum: number;
      let sectorNum: number;
      if (oldDistance > 0) {
        if (wall.posSidedef === 0) continue;
        sidedefNum = wall.posSidedef;
        sectorNum = wall.negSector;
      } else {
        if (wall.negSidedef === 0) continue;
        sidedefNum = wall.negSidedef;
        sectorNum = wall.posSector;
      }
      const sidedef = ctx.sidedef(sidedefNum);
      if (!sidedef) return true;

      let belowHeight = 0;
      if (sectorNum !== -1) belowHeight = SECTOR_DEPTHS[(ctx.sector(sectorNum)?.flags ?? 0) & 0x3]!;

      if (
        (sidedef.below === 0 || wall.z1 - z - belowHeight <= MAX_STEP_HEIGHT) &&
        (sidedef.above === 0 || wall.z2 - z >= OBJECT_HEIGHT) &&
        sidedef.flags & WF_PASSABLE
      ) {
        continue;
      }
      return true;
    }
  }
  return checkNode(node.pos, ctx, oldX, oldY, x, y, z, minDistance) || checkNode(node.neg, ctx, oldX, oldY, x, y, z, minDistance);
}

function squareFlag(tree: BuildNode | null, ctx: GridContext, row: number, col: number): number {
  const leaf = findLeaf(tree, col * FINENESS + FINENESS / 2, row * FINENESS + FINENESS / 2);
  return leaf && leafSector(leaf, ctx).floorTexture !== 0 ? SQUARE_PLAYABLE : 0;
}

function pointFloor(tree: BuildNode | null, ctx: GridContext, x: number, y: number): number {
  const leaf = findLeaf(tree, x, y);
  return leaf ? leafSector(leaf, ctx).floorHeight : 0;
}

function leafSector(leaf: BuildLeaf, ctx: GridContext): { floorTexture: number; floorHeight: number } {
  return ctx.sector(leaf.sector) ?? { floorTexture: 0, floorHeight: 0 };
}

function findLeaf(tree: BuildNode | null, x: number, y: number): BuildLeaf | null {
  while (true) {
    if (!tree) return null;
    if (tree.type === "leaf") return tree;
    const side = f(tree.a * x + tree.b * y + tree.c);
    if (side <= 0.001 && side >= -0.001) tree = tree.pos ?? tree.neg;
    else if (side > 0.001) tree = tree.pos;
    else tree = tree.neg;
  }
}
