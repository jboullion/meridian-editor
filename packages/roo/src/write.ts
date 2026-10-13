// Write a RooFile back to bytes, in the layout roomedit's SaveLevelData uses:
// header, main section at 20, sections in order with backpatched offsets,
// RoomID, then the server section.

import { ByteWriter } from "./binary.ts";
import { computeSecurity } from "./checksum.ts";
import {
  ROO_MAGIC,
  SF,
  versionEncoding,
  type BspNode,
  type ClientWall,
  type EditorWall,
  type RooFile,
  type Sector,
  type Sidedef,
  type Slope,
  type Things,
  type VersionEncoding,
} from "./model.ts";

export interface WriteOptions {
  /** "computed" (default) recomputes the checksum; "stored" keeps `file.security`. */
  security?: "computed" | "stored";
}

export function writeRoo(file: RooFile, options: WriteOptions = {}): Uint8Array {
  const enc = versionEncoding(file.version);
  const w = new ByteWriter();

  for (const b of ROO_MAGIC) w.u8(b);
  w.i32(file.version);
  const securityAt = w.pos;
  w.i32(0);
  const mainAt = w.pos;
  w.i32(0);
  const serverAt = w.pos;
  w.i32(0);

  w.patchI32(mainAt, w.pos);
  w.i32(file.width);
  w.i32(file.height);
  const offsets: number[] = [];
  for (let i = 0; i < 6; i++) {
    offsets.push(w.pos);
    w.i32(0);
  }
  const [nodeAt, cwallAt, rwallAt, sidedefAt, sectorAt, thingAt] = offsets as [number, number, number, number, number, number];

  w.patchI32(nodeAt, w.pos);
  writeList(w, file.nodes, (n) => writeNode(w, n, enc));
  w.patchI32(cwallAt, w.pos);
  writeList(w, file.clientWalls, (cw) => writeClientWall(w, cw, enc));
  w.patchI32(rwallAt, w.pos);
  writeList(w, file.editorWalls, (ew) => writeEditorWall(w, ew));
  w.patchI32(sidedefAt, w.pos);
  writeList(w, file.sidedefs, (sd) => writeSidedef(w, sd));
  w.patchI32(sectorAt, w.pos);
  writeList(w, file.sectors, (sec) => writeSector(w, sec, enc));
  w.patchI32(thingAt, w.pos);
  writeThings(w, file.things);
  if (file.roomId !== null) w.i32(file.roomId);

  w.patchI32(serverAt, w.pos);
  if (file.server) {
    if (!enc.serverGrids) throw new Error(`v${file.version} has no server grids`);
    const g = file.server;
    w.i32(g.rows);
    w.i32(g.cols);
    w.raw(g.playerMove);
    w.raw(g.squareFlags);
    if (enc.monsterGrid) {
      if (!g.monsterMove) throw new Error(`v${file.version} needs a monster grid`);
      w.raw(g.monsterMove);
    }
  }
  w.raw(file.serverExtra);

  w.patchI32(securityAt, options.security === "stored" ? file.security : computeSecurity(file));
  return w.finish();
}

function writeList<T>(w: ByteWriter, items: readonly T[], item: (v: T) => void): void {
  if (items.length > 0xffff) throw new RangeError(`too many records (${items.length}) for a u16 count`);
  w.u16(items.length);
  for (const v of items) item(v);
}

function coord(w: ByteWriter, v: number, enc: VersionEncoding): void {
  if (enc.floatCoords) w.f32(v);
  else w.i32(v);
}

function writeNode(w: ByteWriter, n: BspNode, enc: VersionEncoding): void {
  w.u8(n.type === "internal" ? 1 : 2);
  coord(w, n.bbox.x0, enc);
  coord(w, n.bbox.y0, enc);
  coord(w, n.bbox.x1, enc);
  coord(w, n.bbox.y1, enc);
  if (n.type === "internal") {
    coord(w, n.a, enc);
    coord(w, n.b, enc);
    coord(w, n.c, enc);
    w.u16(n.posChild);
    w.u16(n.negChild);
    w.u16(n.firstWall);
  } else {
    w.u16(n.sector);
    w.i16(n.points.length);
    for (const p of n.points) {
      coord(w, p.x, enc);
      coord(w, p.y, enc);
    }
  }
}

function writeClientWall(w: ByteWriter, cw: ClientWall, enc: VersionEncoding): void {
  w.u16(cw.next);
  w.u16(cw.posSidedef);
  w.u16(cw.negSidedef);
  coord(w, cw.x0, enc);
  coord(w, cw.y0, enc);
  coord(w, cw.x1, enc);
  coord(w, cw.y1, enc);
  if (enc.floatWallLength) w.f32(cw.length);
  else w.u16(cw.length);
  w.i16(cw.posXOffset);
  w.i16(cw.negXOffset);
  w.i16(cw.posYOffset);
  w.i16(cw.negYOffset);
  w.u16(cw.posSector);
  w.u16(cw.negSector);
}

function writeEditorWall(w: ByteWriter, ew: EditorWall): void {
  w.u16(ew.sidedef1);
  w.u16(ew.sidedef2);
  w.i16(ew.xOffset1);
  w.i16(ew.xOffset2);
  w.i16(ew.yOffset1);
  w.i16(ew.yOffset2);
  w.i16(ew.sector1);
  w.i16(ew.sector2);
  w.i32(ew.x0);
  w.i32(ew.y0);
  w.i32(ew.x1);
  w.i32(ew.y1);
}

function writeSidedef(w: ByteWriter, sd: Sidedef): void {
  w.u16(sd.id);
  w.u16(sd.normal);
  w.u16(sd.above);
  w.u16(sd.below);
  w.i32(sd.flags);
  w.u8(sd.animateSpeed);
}

function writeSector(w: ByteWriter, sec: Sector, enc: VersionEncoding): void {
  w.u16(sec.userId);
  w.u16(sec.floorTexture);
  w.u16(sec.ceilingTexture);
  w.i16(sec.xOffset);
  w.i16(sec.yOffset);
  w.i16(sec.floorHeight);
  w.i16(sec.ceilingHeight);
  w.u8(sec.light);
  w.i32(sec.flags);
  if (enc.sectorAnimateSpeed) w.u8(sec.animateSpeed);
  if (sec.flags & SF.SLOPED_FLOOR) writeSlope(w, required(sec.floorSlope, "floor"), enc);
  if (sec.flags & SF.SLOPED_CEILING) writeSlope(w, required(sec.ceilingSlope, "ceiling"), enc);
}

function required(slope: Slope | null, which: string): Slope {
  if (!slope) throw new Error(`sector is flagged with a sloped ${which} but has no ${which} slope`);
  return slope;
}

function writeSlope(w: ByteWriter, s: Slope, enc: VersionEncoding): void {
  coord(w, s.a, enc);
  coord(w, s.b, enc);
  coord(w, s.c, enc);
  coord(w, s.d, enc);
  if (enc.floatSlopeOrigin) {
    w.f32(s.x);
    w.f32(s.y);
  } else {
    w.i32(s.x);
    w.i32(s.y);
  }
  w.i32(s.angle);
  for (const p of s.points) {
    w.i16(p.x);
    w.i16(p.y);
    w.i16(p.z);
  }
}

function writeThings(w: ByteWriter, things: Things): void {
  const count = things.things.length;
  if (things.format === "corners") {
    if (count > 2) throw new Error(`corner things hold at most 2, got ${count}`);
    w.u16(count);
    for (const t of things.things) {
      w.i32(t.x);
      w.i32(t.y);
    }
    return;
  }
  if (count <= 2) throw new Error(`full thing records need more than 2 things, got ${count}`);
  w.u16(count);
  for (const t of things.things) {
    w.i32(t.type);
    w.i32(t.angle);
    w.i32(t.x);
    w.i32(t.y);
    w.i32(t.when);
    w.i32(t.xExit);
    w.i32(t.yExit);
    w.i32(t.flags);
    const comment = new Uint8Array(64);
    comment.set(t.comment.subarray(0, 64));
    w.raw(comment);
  }
}
