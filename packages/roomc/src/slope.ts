// ComputeSlopeInfo (roomedit/source/save.cpp): the plane through a slope's three
// points, in client units, with a normal of length FINENESS pointing up for
// floors and down for ceilings. The texture origin is the first point.
//
// Current roomedit does this in double. Some shipped 104 rooms were last saved
// by a build that used float throughout; `float` reproduces that.

import { BLAK_FACTOR, FINENESS, type Slope } from "@meridian-editor/roo";
import type { SourceSlope } from "./source.ts";

export interface SlopeFrame {
  /** Editor coordinates of the client origin: the room box's left and top. */
  mapMinX: number;
  mapMaxY: number;
}

export function computeSlope(slope: SourceSlope, floor: boolean, frame: SlopeFrame, float = false): Slope | null {
  const p = slope.points.map(([x, y, z]) => ({
    x: (x - frame.mapMinX) * BLAK_FACTOR,
    y: (frame.mapMaxY - y) * BLAK_FACTOR,
    z: z * BLAK_FACTOR,
  })) as [Point, Point, Point];
  const plane = float ? planeFloat(p) : planeDouble(p);
  if (!plane) return null;
  let [a, b, c, d] = plane;
  if ((floor && c < 0) || (!floor && c > 0)) {
    a = -a;
    b = -b;
    c = -c;
    d = -d;
  }
  return {
    a,
    b,
    c,
    d,
    x: p[0].x,
    y: p[0].y,
    angle: slope.angle,
    points: slope.points.map(([x, y, z]) => ({ x, y, z })) as Slope["points"],
  };
}

interface Point {
  x: number;
  y: number;
  z: number;
}

function planeDouble(p: [Point, Point, Point]): [number, number, number, number] | null {
  const u = [p[1].x - p[0].x, p[1].y - p[0].y, p[1].z - p[0].z] as const;
  const v = [p[2].x - p[0].x, p[2].y - p[0].y, p[2].z - p[0].z] as const;
  const uv = [u[2] * v[1] - u[1] * v[2], u[0] * v[2] - u[2] * v[0], u[1] * v[0] - u[0] * v[1]] as const;
  const len = Math.sqrt(uv[0] * uv[0] + uv[1] * uv[1] + uv[2] * uv[2]);
  if (len === 0) return null;
  const a = (uv[0] * FINENESS) / len;
  const b = (uv[1] * FINENESS) / len;
  const c = (uv[2] * FINENESS) / len;
  return [a, b, c, -(a * p[0].x + b * p[0].y + c * p[0].z)];
}

function planeFloat(p: [Point, Point, Point]): [number, number, number, number] | null {
  const f = Math.fround;
  const u = [p[1].x - p[0].x, p[1].y - p[0].y, p[1].z - p[0].z] as const;
  const v = [p[2].x - p[0].x, p[2].y - p[0].y, p[2].z - p[0].z] as const;
  const uv = [f(f(u[2] * v[1]) - f(u[1] * v[2])), f(f(u[0] * v[2]) - f(u[2] * v[0])), f(f(u[1] * v[0]) - f(u[0] * v[1]))] as const;
  const len = f(Math.sqrt(f(f(f(uv[0] * uv[0]) + f(uv[1] * uv[1])) + f(uv[2] * uv[2]))));
  if (len === 0) return null;
  const a = f(f(uv[0] * FINENESS) / len);
  const b = f(f(uv[1] * FINENESS) / len);
  const c = f(f(uv[2] * FINENESS) / len);
  return [a, b, c, f(-f(f(f(a * p[0].x) + f(b * p[0].y)) + f(c * p[0].z)))];
}

/** Whether two slopes store the same bytes (plane as f32). */
export function sameStoredPlane(x: Slope, y: Slope): boolean {
  const f = Math.fround;
  return Object.is(f(x.a), f(y.a)) && Object.is(f(x.b), f(y.b)) && Object.is(f(x.c), f(y.c)) && Object.is(f(x.d), f(y.d));
}

/** The client origin compile will use: the box of the first two things, else the vertex bounds. */
export function slopeFrame(vertices: readonly [number, number][], things: readonly { x: number; y: number }[]): SlopeFrame {
  if (things.length >= 2) {
    return {
      mapMinX: Math.min(things[0]!.x, things[1]!.x),
      mapMaxY: Math.max(things[0]!.y, things[1]!.y),
    };
  }
  let mapMinX = Infinity;
  let mapMaxY = -Infinity;
  for (const [x, y] of vertices) {
    mapMinX = Math.min(mapMinX, x);
    mapMaxY = Math.max(mapMaxY, y);
  }
  return { mapMinX, mapMaxY };
}
