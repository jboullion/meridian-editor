// Read a .roo file of any version from 12 to 15 into a lossless RooFile.
// Field order follows roomedit/source/save.cpp in both trees; the version
// switches follow clientd3d/bspload.c and roomedit/source/load.cpp.

import { ByteReader } from "./binary.ts";
import {
  ROO_MAGIC,
  SF,
  versionEncoding,
  type BspNode,
  type ClientWall,
  type EditorWall,
  type RooFile,
  type Sector,
  type ServerGrids,
  type Sidedef,
  type Slope,
  type SlopePoint,
  type Things,
  type VersionEncoding,
} from "./model.ts";

export const MIN_READ_VERSION = 12;
export const MAX_READ_VERSION = 15;

export class RooFormatError extends Error {}

export function readRoo(bytes: Uint8Array): RooFile {
  const r = new ByteReader(bytes);
  for (const b of ROO_MAGIC) {
    if (r.remaining < 1 || r.u8() !== b) throw new RooFormatError("not a .roo file (bad magic)");
  }
  const version = r.i32();
  if (version < MIN_READ_VERSION || version > MAX_READ_VERSION) {
    throw new RooFormatError(`unsupported .roo version ${version} (reads ${MIN_READ_VERSION}-${MAX_READ_VERSION})`);
  }
  const enc = versionEncoding(version);
  const security = r.i32();
  const mainPos = r.i32();
  const serverPos = r.i32();

  r.seek(mainPos);
  const width = r.i32();
  const height = r.i32();
  const nodePos = r.i32();
  const cwallPos = r.i32();
  const rwallPos = r.i32();
  const sidedefPos = r.i32();
  const sectorPos = r.i32();
  const thingPos = r.i32();

  r.seek(nodePos);
  const nodes = readList(r, () => readNode(r, enc));
  r.seek(cwallPos);
  const clientWalls = readList(r, () => readClientWall(r, enc));
  r.seek(rwallPos);
  const editorWalls = readList(r, () => readEditorWall(r));
  r.seek(sidedefPos);
  const sidedefs = readList(r, () => readSidedef(r));
  r.seek(sectorPos);
  const sectors = readList(r, () => readSector(r, enc));
  r.seek(thingPos);
  const things = readThings(r);

  // save.cpp always writes a RoomID after the things; tolerate files without one.
  const thingsEnd = r.pos;
  const mainEnd = serverPos >= thingsEnd && serverPos <= r.length ? serverPos : r.length;
  let roomId: number | null = null;
  if (mainEnd - thingsEnd >= 4) roomId = r.i32();
  if (r.pos !== mainEnd) {
    throw new RooFormatError(`${mainEnd - r.pos} unexpected bytes between the things and the server section`);
  }

  r.seek(mainEnd);
  let server: ServerGrids | null = null;
  if (enc.serverGrids) server = readServerGrids(r, enc);
  const serverExtra = r.take(r.remaining);

  return {
    version,
    security,
    width,
    height,
    nodes,
    clientWalls,
    editorWalls,
    sidedefs,
    sectors,
    things,
    roomId,
    server,
    serverExtra,
  };
}

function readList<T>(r: ByteReader, item: () => T): T[] {
  const count = r.u16();
  const out: T[] = [];
  for (let i = 0; i < count; i++) out.push(item());
  return out;
}

function coord(r: ByteReader, enc: VersionEncoding): number {
  return enc.floatCoords ? r.f32() : r.i32();
}

function readNode(r: ByteReader, enc: VersionEncoding): BspNode {
  const type = r.u8();
  const bbox = { x0: coord(r, enc), y0: coord(r, enc), x1: coord(r, enc), y1: coord(r, enc) };
  if (type === 1) {
    const a = coord(r, enc);
    const b = coord(r, enc);
    const c = coord(r, enc);
    return { type: "internal", bbox, a, b, c, posChild: r.u16(), negChild: r.u16(), firstWall: r.u16() };
  }
  if (type === 2) {
    const sector = r.u16();
    const count = r.i16();
    const points = [];
    for (let i = 0; i < count; i++) points.push({ x: coord(r, enc), y: coord(r, enc) });
    return { type: "leaf", bbox, sector, points };
  }
  throw new RooFormatError(`bad BSP node type ${type} at ${r.pos - 17}`);
}

function readClientWall(r: ByteReader, enc: VersionEncoding): ClientWall {
  return {
    next: r.u16(),
    posSidedef: r.u16(),
    negSidedef: r.u16(),
    x0: coord(r, enc),
    y0: coord(r, enc),
    x1: coord(r, enc),
    y1: coord(r, enc),
    length: enc.floatWallLength ? r.f32() : r.u16(),
    posXOffset: r.i16(),
    negXOffset: r.i16(),
    posYOffset: r.i16(),
    negYOffset: r.i16(),
    posSector: r.u16(),
    negSector: r.u16(),
  };
}

function readEditorWall(r: ByteReader): EditorWall {
  return {
    sidedef1: r.u16(),
    sidedef2: r.u16(),
    xOffset1: r.i16(),
    xOffset2: r.i16(),
    yOffset1: r.i16(),
    yOffset2: r.i16(),
    sector1: r.i16(),
    sector2: r.i16(),
    x0: r.i32(),
    y0: r.i32(),
    x1: r.i32(),
    y1: r.i32(),
  };
}

function readSidedef(r: ByteReader): Sidedef {
  return {
    id: r.u16(),
    normal: r.u16(),
    above: r.u16(),
    below: r.u16(),
    flags: r.i32(),
    animateSpeed: r.u8(),
  };
}

function readSector(r: ByteReader, enc: VersionEncoding): Sector {
  const userId = r.u16();
  const floorTexture = r.u16();
  const ceilingTexture = r.u16();
  const xOffset = r.i16();
  const yOffset = r.i16();
  const floorHeight = r.i16();
  const ceilingHeight = r.i16();
  const light = r.u8();
  const flags = r.i32();
  const animateSpeed = enc.sectorAnimateSpeed ? r.u8() : 0;
  const floorSlope = flags & SF.SLOPED_FLOOR ? readSlope(r, enc) : null;
  const ceilingSlope = flags & SF.SLOPED_CEILING ? readSlope(r, enc) : null;
  return {
    userId,
    floorTexture,
    ceilingTexture,
    xOffset,
    yOffset,
    floorHeight,
    ceilingHeight,
    light,
    flags,
    animateSpeed,
    floorSlope,
    ceilingSlope,
  };
}

function readSlope(r: ByteReader, enc: VersionEncoding): Slope {
  const a = coord(r, enc);
  const b = coord(r, enc);
  const c = coord(r, enc);
  const d = coord(r, enc);
  const x = enc.floatSlopeOrigin ? r.f32() : r.i32();
  const y = enc.floatSlopeOrigin ? r.f32() : r.i32();
  const angle = r.i32();
  const point = (): SlopePoint => ({ x: r.i16(), y: r.i16(), z: r.i16() });
  return { a, b, c, d, x, y, angle, points: [point(), point(), point()] };
}

function readThings(r: ByteReader): Things {
  const count = r.u16();
  if (count <= 2) {
    const things = [];
    for (let i = 0; i < count; i++) things.push({ x: r.i32(), y: r.i32() });
    return { format: "corners", things };
  }
  const things = [];
  for (let i = 0; i < count; i++) {
    things.push({
      type: r.i32(),
      angle: r.i32(),
      x: r.i32(),
      y: r.i32(),
      when: r.i32(),
      xExit: r.i32(),
      yExit: r.i32(),
      flags: r.i32(),
      comment: r.take(64),
    });
  }
  return { format: "full", things };
}

function readServerGrids(r: ByteReader, enc: VersionEncoding): ServerGrids | null {
  if (r.remaining < 8) return null;
  const start = r.pos;
  const rows = r.i32();
  const cols = r.i32();
  const size = rows * cols;
  const grids = enc.monsterGrid ? 3 : 2;
  if (rows < 0 || cols < 0 || r.remaining < size * grids) {
    r.seek(start);
    return null;
  }
  return {
    rows,
    cols,
    playerMove: r.take(size),
    squareFlags: r.take(size),
    monsterMove: enc.monsterGrid ? r.take(size) : null,
  };
}
