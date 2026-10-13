// The .roo file as stored: every section, in file order, with the values
// exactly as written. Reading then writing a RooFile gives the same bytes.
//
// Layout (roomedit/source/save.cpp SaveLevelData, both trees):
//   header   magic "ROO\xb1", i32 version, i32 security, i32 main offset, i32 server offset
//   main     i32 width, i32 height, six i32 offsets (node, cwall, rwall, sidedef, sector, thing)
//            then each section as a u16 count plus records, in that order,
//            and an i32 RoomID after the things
//   server   original: i32 rows, i32 cols, three byte grids. Server 104: empty.
//
// Coordinates in nodes and client walls are client "fine" units (FINENESS =
// 1024 per square, editor units × 16, y flipped). Editor walls and slope
// vertices are raw editor units (64 per square).

export const ROO_MAGIC: readonly number[] = [0x52, 0x4f, 0x4f, 0xb1];
export const SECURITY_XOR = 0x89ab786c | 0;
export const FINENESS = 1024;
/** Editor units to client units (roomedit BLAK_FACTOR). */
export const BLAK_FACTOR = 16;

/** Sector flags (roomedit/include/bsp.h SF_*). Bit 0x2000 is set on many 104 sectors but defined nowhere; keep it. */
export const SF = {
  DEPTH_MASK: 0x3,
  SCROLL_SPEED_MASK: 0xc,
  SCROLL_DIRECTION_MASK: 0x70,
  SCROLL_FLOOR: 0x80,
  SCROLL_CEILING: 0x100,
  FLICKER: 0x200,
  SLOPED_FLOOR: 0x400,
  SLOPED_CEILING: 0x800,
} as const;

/** Sidedef (wall) flags (roomedit/include/bsp.h WF_*). The last three are original-only. */
export const WF = {
  BACKWARDS: 0x1,
  TRANSPARENT: 0x2,
  PASSABLE: 0x4,
  MAP_NEVER: 0x8,
  MAP_ALWAYS: 0x10,
  NOLOOKTHROUGH: 0x20,
  ABOVE_BOTTOMUP: 0x40,
  BELOW_TOPDOWN: 0x80,
  NORMAL_TOPDOWN: 0x100,
  NO_VTILE: 0x200,
  SCROLL_SPEED_MASK: 0xc00,
  SCROLL_DIRECTION_MASK: 0x7000,
  /** Original only: translucency level 0-3 in bits 15-16. */
  TRANSLUCENCY_MASK: 0x18000,
  /** Original only. */
  NO_HTILE: 0x20000,
} as const;

export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface InternalNode {
  type: "internal";
  bbox: Box;
  /** Splitting plane ax + by + c = 0. */
  a: number;
  b: number;
  c: number;
  /** 1-based node numbers; 0 = none. */
  posChild: number;
  negChild: number;
  /** 1-based client wall number of the first wall in this plane; 0 = none. */
  firstWall: number;
}

export interface LeafNode {
  type: "leaf";
  bbox: Box;
  /** 1-based sector number; 0 = none. */
  sector: number;
  points: { x: number; y: number }[];
}

export type BspNode = InternalNode | LeafNode;

export interface ClientWall {
  /** 1-based number of the next wall in the same plane; 0 = end. */
  next: number;
  /** 1-based sidedef numbers; 0 = none. */
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
  /** 1-based sector numbers; 0 = none. */
  posSector: number;
  negSector: number;
}

/** roomedit's own linedef record, which it rebuilds the editor map from. */
export interface EditorWall {
  /** 1-based file sidedef numbers; 0 = none. */
  sidedef1: number;
  sidedef2: number;
  xOffset1: number;
  xOffset2: number;
  yOffset1: number;
  yOffset2: number;
  /** 0-based sector numbers; -1 = none. */
  sector1: number;
  sector2: number;
  /** Raw editor coordinates. */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface Sidedef {
  /** server_id that Kod uses for AnimateWall / ChangeTexture. */
  id: number;
  normal: number;
  above: number;
  below: number;
  flags: number;
  animateSpeed: number;
}

export interface SlopePoint {
  /** Raw editor vertex coordinates and height. */
  x: number;
  y: number;
  z: number;
}

export interface Slope {
  a: number;
  b: number;
  c: number;
  d: number;
  /** Texture origin in client units (f32 in v13, i32 otherwise). */
  x: number;
  y: number;
  /** Client angle units, 4096 per circle. */
  angle: number;
  points: [SlopePoint, SlopePoint, SlopePoint];
}

export interface Sector {
  /** server_id that Kod uses for SetSector / SetSectorLight. */
  userId: number;
  floorTexture: number;
  ceilingTexture: number;
  xOffset: number;
  yOffset: number;
  floorHeight: number;
  ceilingHeight: number;
  light: number;
  flags: number;
  animateSpeed: number;
  floorSlope: Slope | null;
  ceilingSlope: Slope | null;
}

/** Two or fewer things are stored as bare corners: the room's bounding box. */
export interface CornerThing {
  x: number;
  y: number;
}

/** More than two things use roomedit's 96-byte record. Neither game loads these. */
export interface FullThing {
  type: number;
  angle: number;
  x: number;
  y: number;
  when: number;
  xExit: number;
  yExit: number;
  flags: number;
  /** 64 raw bytes, NUL-padded. */
  comment: Uint8Array;
}

export type Things = { format: "corners"; things: CornerThing[] } | { format: "full"; things: FullThing[] };

/** The original server's grids, row-major, rows × cols bytes each. */
export interface ServerGrids {
  rows: number;
  cols: number;
  playerMove: Uint8Array;
  squareFlags: Uint8Array;
  /** Present from v12. */
  monsterMove: Uint8Array | null;
}

export interface RooFile {
  version: number;
  /** The security value stored in the file. */
  security: number;
  width: number;
  height: number;
  /** In file order (pre-order: node, + subtree, − subtree). */
  nodes: BspNode[];
  clientWalls: ClientWall[];
  editorWalls: EditorWall[];
  sidedefs: Sidedef[];
  sectors: Sector[];
  things: Things;
  /** Trailing RoomID; null for files that end the main section at the things. */
  roomId: number | null;
  server: ServerGrids | null;
  /** Server-section bytes not covered by `server` (normally empty). */
  serverExtra: Uint8Array;
}

/** How a given file version stores its values. */
export interface VersionEncoding {
  /** Node, leaf and client wall coordinates as f32; i32 before v13. */
  floatCoords: boolean;
  /** Client wall length as f32; u16 before v13. */
  floatWallLength: boolean;
  /** Slope texture origin as f32: only the original's v13. */
  floatSlopeOrigin: boolean;
  /** Sector animate_speed byte, from v10. */
  sectorAnimateSpeed: boolean;
  /** The original server section with grids; 104 (v14+) writes none. */
  serverGrids: boolean;
  /** The monster grid, from v12. */
  monsterGrid: boolean;
  /** Which checksum rule applies. */
  checksum: "original" | "104";
}

export function versionEncoding(version: number): VersionEncoding {
  return {
    floatCoords: version >= 13,
    floatWallLength: version >= 13,
    floatSlopeOrigin: version === 13,
    sectorAnimateSpeed: version >= 10,
    serverGrids: version < 14,
    monsterGrid: version >= 12,
    checksum: version >= 14 ? "104" : "original",
  };
}
