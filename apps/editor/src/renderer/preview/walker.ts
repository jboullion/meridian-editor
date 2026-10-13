// Walking a room the way a player does, for the 3D preview's walk mode: the
// client's own movement rules (clientd3d/move.c UserMovePlayer, FindIntersection,
// IntersectNode, SlideAlongWall; moveobj.c for climbing and falling).
//
// Ported from meridian-browser packages/world/src/movement.ts (GPL-2.0, same
// authors), without the server updates, objects or sounds. Keep the two in step;
// walker.test.ts checks them against each other on shipped rooms.
//
// Units: client fine (1024 a square), x east and y south from the room box's
// top-left corner; angles 0..4095 with (cos a, sin a) along x, y.

import { FINENESS } from "@meridian-editor/roo";
import { floorHeightAt, leafAt, SF, WF, type Room, type Wall } from "./clientRoom.ts";

const MOVEUNITS = FINENESS >> 2; // draw3d.h
const MOVE_DELAY = 85; // ms per MOVEUNITS
const NUM_STEPS_PER_SECOND = 210;
const STEPS_PER_MOVE = 20;
const MAX_STEP_HEIGHT = 24 * 16; // HeightKodToClient(24)
const MIN_SIDE_MOVE = MOVEUNITS / 4;
const PLAYER_WIDTH = (31 * 64) / 4; // game.c player.width
export const PLAYER_HEIGHT = (3 * FINENESS) / 4; // game.c player.height
/** The eye is at the player's height above the floor (player.viewHeight). */
export const EYE_HEIGHT = PLAYER_HEIGHT;
const TURNDEGREES = 64; // game.h: 4096 / 64 per TURN_DELAY
const TURN_DELAY = 85;
const CLIMB_VELOCITY = (FINENESS * 9) / 2; // move.h, units per second
const FALL_VELOCITY = (-FINENESS * 2) / 3;
const GRAVITY = -5 * FINENESS; // moveobj.h, units / s / s
const SECTOR_DEPTHS = [0, FINENESS / 5, (2 * FINENESS) / 5, (3 * FINENESS) / 5];

export interface WalkInput {
  /** +1 forward, -1 back */
  forward: number;
  /** +1 right, -1 left */
  strafe: number;
  run: boolean;
}

/** client3d.c GetFloorBase: the floor under a point minus its water depth; null outside every sector. */
export function floorBase(room: Room, x: number, y: number): number | null {
  const leaf = leafAt(room, x, y);
  if (!leaf || !leaf.sector) return null;
  const s = room.sectors[leaf.sector - 1]!;
  return floorHeightAt(s, x, y) - SECTOR_DEPTHS[s.flags & SF.DEPTH_MASK]!;
}

export class Walker {
  x = 0;
  y = 0;
  /** Floor under the eye (minus water depth), climbing and falling like the client. */
  z = 0;
  angle = 0;
  room: Room | null = null;
  /** The walking bob, client units (BounceUser). */
  bounce = 0;
  /** The wall that stopped the last step, if one did. */
  blockedBy: Wall | null = null;
  private destZ = 0;
  private vZ = 0;
  private bounceTime = 0;
  private readonly minDistance = Math.max(1, PLAYER_WIDTH / 2);

  /** Put the walker somewhere (ServerMovedPlayer): no climbing, straight onto the floor. */
  place(x: number, y: number): void {
    this.x = x;
    this.y = y;
    this.z = this.destZ = this.floorBase(x, y) ?? this.z;
    this.vZ = 0;
  }

  /** client3d.c GetFloorBase: floor minus water depth; null outside every sector. */
  floorBase(x: number, y: number): number | null {
    return this.room ? floorBase(this.room, x, y) : null;
  }

  /** Keyboard turning at TURNDEGREES per TURN_DELAY ms (UserTurnPlayer); `fast` triples it. */
  turnKeys(dir: number, fast: boolean, dt: number): void {
    if (!dir) return;
    this.turnBy((dir * (fast ? 3 : 1) * TURNDEGREES * Math.min(dt, TURN_DELAY * 4)) / TURN_DELAY);
  }

  turnBy(delta: number): void {
    this.angle = (((this.angle + delta) % 4096) + 4096) % 4096;
  }

  /** One frame: move by the input (UserMovePlayer), then climb or fall towards the floor. */
  update(input: WalkInput, dt: number): void {
    if ((input.forward || input.strafe) && this.room) this.step(input, dt);
    this.settleHeight(dt);
  }

  private step(input: WalkInput, dt: number): void {
    const room = this.room!;
    // Direction (A_FORWARD, A_SLIDELEFT, ...): offsets in eighths of a circle
    const f = Math.sign(input.forward);
    const s = Math.sign(input.strafe);
    const eighths = f > 0 ? (s > 0 ? 1 : s < 0 ? 7 : 0) : f < 0 ? (s > 0 ? 3 : s < 0 ? 5 : 4) : s > 0 ? 2 : 6;
    const angle = (this.angle + (eighths * 4096) / 8) % 4096;
    let distance = input.run ? 2 * MOVEUNITS : MOVEUNITS;

    // Wading slows you down
    const leaf0 = leafAt(room, this.x, this.y);
    const depth = leaf0?.sector ? room.sectors[leaf0.sector - 1]!.flags & SF.DEPTH_MASK : 0;
    distance = [distance, (distance * 3) / 4, distance / 2, distance / 4][depth]!;

    dt = Math.max(1, dt);
    if (dt < MOVE_DELAY) distance = (distance * dt) / MOVE_DELAY;

    const rad = (angle * 2 * Math.PI) / 4096;
    const dx = Math.trunc(distance * Math.cos(rad));
    const dy = Math.trunc(distance * Math.sin(rad));
    const numSteps = Math.max(1, Math.min(STEPS_PER_MOVE, Math.floor((NUM_STEPS_PER_SECOND * dt) / 1000)));
    const xinc = Math.trunc(dx / numSteps);
    const yinc = Math.trunc(dy / numSteps);
    let lastX = this.x;
    let lastY = this.y;
    let x = lastX;
    let y = lastY;
    let moved = false;
    this.blockedBy = null;

    for (let i = 0; i < numSteps; i++) {
      x = lastX + xinc;
      y = lastY + yinc;
      const z = Math.max(this.z, this.floorBase(lastX, lastY) ?? this.z);
      const leaf = leafAt(room, x, y);
      if (!leaf || !leaf.sector) {
        x = lastX;
        y = lastY;
        break;
      }
      // Like the C code: one slide, then check again, slide again, and finally try small sideways steps.
      let wall = this.findIntersection(lastX, lastY, x, y, z);
      if (wall) [x, y] = slideAlongWall(wall, lastX, lastY, x, y);
      wall = this.findIntersection(lastX, lastY, x, y, z);
      if (wall) {
        this.blockedBy = wall;
        [x, y] = slideAlongWall(wall, lastX, lastY, x, y);
        wall = this.findIntersection(lastX, lastY, x, y, z);
        if (wall) {
          for (const side of [3, 1]) {
            const a = ((angle + (side * 4096) / 4) % 4096) * ((2 * Math.PI) / 4096);
            x = lastX + Math.trunc(MIN_SIDE_MOVE * Math.cos(a));
            y = lastY + Math.trunc(MIN_SIDE_MOVE * Math.sin(a));
            wall = this.findIntersection(lastX, lastY, x, y, z);
            if (!wall) break;
          }
          if (wall) {
            x = lastX;
            y = lastY;
            break;
          }
        }
      }
      // The room's edge: in the game that's an edge exit for the server to judge; here it's a wall.
      if (!this.isInRoom(x, y)) {
        x = lastX;
        y = lastY;
        break;
      }
      lastX = x;
      lastY = y;
      moved = true;
    }
    if (!moved && x === this.x && y === this.y) return;
    this.x = x;
    this.y = y;
    // Climb or fall to the new floor (move.c: v_z with CLIMB/FALL velocity)
    const fz = this.floorBase(x, y);
    if (fz !== null) {
      this.destZ = fz;
      if (fz > this.z && this.vZ <= 0) this.vZ = CLIMB_VELOCITY;
      else if (fz < this.z && this.vZ >= 0) this.vZ = FALL_VELOCITY;
    }
    // Walking bob (BounceUser): BOUNCE_HEIGHT * sin(t), t advancing one radian per MOVE_DELAY
    this.bounceTime += Math.min(dt, MOVE_DELAY) / MOVE_DELAY;
    this.bounce = (FINENESS >> 5) * Math.sin(this.bounceTime);
  }

  /** moveobj.c MoveSingleVertically for the player. */
  private settleHeight(dt: number): void {
    if (this.vZ === 0) return;
    this.z += (dt * this.vZ) / 1000;
    if (this.vZ > 0) {
      if (this.z >= this.destZ) {
        this.z = this.destZ;
        this.vZ = 0;
      }
    } else if (this.z <= this.destZ) {
      this.z = this.destZ;
      this.vZ = 0;
    } else this.vZ += (GRAVITY * dt) / 1000;
  }

  private isInRoom(x: number, y: number): boolean {
    const b = this.room!.thingsBox;
    return !(x <= 0 || x >= b.maxX || y <= 0 || y >= b.maxY);
  }

  /** move.c FindIntersection: the first wall (depth-first) blocking a step. */
  private findIntersection(oldX: number, oldY: number, newX: number, newY: number, z: number): Wall | null {
    const room = this.room!;
    const visit = (idx: number): Wall | null => {
      const n = room.nodes[idx];
      if (!n || n.type !== "internal") return null;
      const w = this.intersectNode(idx, oldX, oldY, newX, newY, z);
      if (w) return w;
      return (n.pos ? visit(n.pos - 1) : null) ?? (n.neg ? visit(n.neg - 1) : null);
    };
    return room.nodes.length ? visit(0) : null;
  }

  /** move.c IntersectNode */
  private intersectNode(idx: number, oldX: number, oldY: number, newX: number, newY: number, z: number): Wall | null {
    const room = this.room!;
    const n = room.nodes[idx]!;
    if (n.type !== "internal") return null;
    const md = this.minDistance;
    const [bx0, by0, bx1, by1] = n.bbox;
    if (bx0 - newX > md || newX - bx1 > md || by0 - newY > md || newY - by1 > md) return null;
    const planeDistance = n.a * newX + n.b * newY + n.c;
    const oldDistance = n.a * oldX + n.b * oldY + n.c;
    if (Math.abs(planeDistance) / FINENESS > md || Math.abs(planeDistance) > Math.abs(oldDistance)) return null;
    const md2 = md * md;
    for (const wi of n.walls) {
      const w = room.walls[wi]!;
      if (newX < Math.min(w.x0, w.x1) - md || newX > Math.max(w.x0, w.x1) + md) continue;
      if (newY < Math.min(w.y0, w.y1) - md || newY > Math.max(w.y0, w.y1) + md) continue;
      // The side we're on decides which sidedef we'd walk through
      const sdNum = oldDistance > 0 ? w.posSidedef : w.negSidedef;
      const otherNum = oldDistance > 0 ? w.negSector : w.posSector;
      if (!sdNum) continue;
      const sd = room.sidedefs[sdNum - 1]!;
      const belowHeight = otherNum ? SECTOR_DEPTHS[room.sectors[otherNum - 1]!.flags & SF.DEPTH_MASK]! : 0;
      // Passable if: low enough step, enough headroom, and the wall is passable
      if ((!sd.belowType || w.z1 - belowHeight - z <= MAX_STEP_HEIGHT) && (!sd.aboveType || w.z2 - z >= PLAYER_HEIGHT) && sd.flags & WF.PASSABLE) continue;
      let ddx = newX - w.x0;
      let ddy = newY - w.y0;
      const d0 = ddx * ddx + ddy * ddy;
      ddx = newX - w.x1;
      ddy = newY - w.y1;
      const d1 = ddx * ddx + ddy * ddy;
      const lx = w.x1 - w.x0;
      const ly = w.y1 - w.y0;
      const lenWall2 = lx * lx + ly * ly;
      if (d0 > lenWall2) {
        const ox = oldX - w.x1;
        const oy = oldY - w.y1;
        if (d1 < md2 && d1 <= ox * ox + oy * oy) return w;
      } else if (d1 > lenWall2) {
        const ox = oldX - w.x0;
        const oy = oldY - w.y0;
        if (d0 < md2 && d0 <= ox * ox + oy * oy) return w;
      } else return w;
    }
    return null;
  }
}

/** move.c SlideAlongWall: keep the component of the move along the wall. */
function slideAlongWall(w: Wall, xOld: number, yOld: number, xNew: number, yNew: number): [number, number] {
  const dx = xNew - xOld;
  const dy = yNew - yOld;
  const wx = w.x1 - w.x0;
  const wy = w.y1 - w.y0;
  const num = dx * wx + dy * wy;
  const denom = wx * wx + wy * wy || 1;
  return [xOld + Math.round((wx * num) / denom), yOld + Math.round((wy * num) / denom)];
}
