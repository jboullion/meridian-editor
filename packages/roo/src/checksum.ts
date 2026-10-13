// The room security checksum: a wrapping int32 sum built up while the file is
// written, XORed with 0x89ab786c and stored at offset 8.
//
// original (v12/v13, MeridianSteam roomedit/source/save.cpp:59-338): also sums
//   the raw 32-bit words of planes, leaf points and client wall ends.
// 104 (v14/v15, Server-104 roomedit/source/save.cpp:114-319): integers only.
// Both add heights as unsigned 16-bit values (`WORD word = floorh`).

import { floatBits } from "./binary.ts";
import { SECURITY_XOR, versionEncoding, type RooFile } from "./model.ts";

export function computeSecurity(file: RooFile): number {
  const enc = versionEncoding(file.version);
  const withCoords = enc.checksum === "original";
  const word = (v: number): number => (enc.floatCoords ? floatBits(v) : v | 0);
  let s = file.version | 0;
  const add = (v: number): void => {
    s = (s + v) | 0;
  };

  for (const n of file.nodes) {
    if (n.type === "internal") {
      if (withCoords) {
        add(word(n.a));
        add(word(n.b));
        add(word(n.c));
      }
      add(n.firstWall & 0xffff);
    } else if (withCoords) {
      for (const p of n.points) {
        add(word(p.x));
        add(word(p.y));
      }
    }
  }

  for (const w of file.clientWalls) {
    add((w.posSidedef & 0xffff) + (w.negSidedef & 0xffff));
    if (withCoords) {
      add(word(w.x0));
      add(word(w.y0));
      add(word(w.x1));
      add(word(w.y1));
    }
    add(w.posSector & 0xffff);
    add(w.negSector & 0xffff);
  }

  for (const d of file.sidedefs) {
    add((d.id & 0xffff) + (d.normal & 0xffff) + (d.above & 0xffff) + (d.below & 0xffff));
    add(d.flags | 0);
  }

  for (const sec of file.sectors) {
    add(sec.userId & 0xffff);
    add(sec.floorTexture & 0xffff);
    add(sec.ceilingTexture & 0xffff);
    add(sec.floorHeight & 0xffff);
    add(sec.ceilingHeight & 0xffff);
    add(sec.light & 0xff);
    add(sec.flags | 0);
  }

  return (s ^ SECURITY_XOR) | 0;
}
