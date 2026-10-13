// Checks a parsed .roo against a target: what its client or server would
// reject or load wrong.

import { computeSecurity } from "./checksum.ts";
import { FINENESS, type RooFile } from "./model.ts";
import { profileForVersion, type TargetProfile } from "./profiles.ts";

export interface Issue {
  severity: "error" | "warning";
  message: string;
}

export function checkRoo(file: RooFile, profile: TargetProfile = profileForVersion(file.version)): Issue[] {
  const issues: Issue[] = [];
  const error = (message: string): void => void issues.push({ severity: "error", message });
  const warn = (message: string): void => void issues.push({ severity: "warning", message });

  if (!profile.readableVersions.includes(file.version)) {
    error(`version ${file.version} is not loaded by the ${profile.name} target (needs ${profile.readableVersions.join(" or ")})`);
  }

  const computed = computeSecurity(file);
  if (computed !== file.security) {
    error(`security checksum is ${hex(file.security)}, expected ${hex(computed)}`);
  }

  checkReferences(file, error);

  const thingCount = file.things.things.length;
  if (profile.exactlyTwoThings && (thingCount !== 2 || file.things.format !== "corners")) {
    error(`${profile.name} needs exactly 2 corner things, found ${thingCount}`);
  } else if (thingCount < 2) {
    warn(`only ${thingCount} things; the room box falls back to the map bounds`);
  }

  file.sidedefs.forEach((sd, i) => {
    const extra = sd.flags & ~profile.wallFlagMask;
    if (extra) error(`sidedef ${i + 1} uses wall flags ${hex(extra)} that ${profile.name} doesn't support`);
  });

  if (!profile.allowNegativeHeights) {
    file.sectors.forEach((sec, i) => {
      if (sec.floorHeight < 0 || sec.ceilingHeight < 0) {
        error(`sector ${i + 1} has a negative height (${sec.floorHeight}/${sec.ceilingHeight}); ${profile.name} reads heights as unsigned`);
      }
    });
  }

  if (file.version < 14) {
    if (!file.server) error("missing server grids");
    else if (file.server.rows !== Math.floor(file.height / FINENESS) || file.server.cols !== Math.floor(file.width / FINENESS)) {
      warn(`server grid is ${file.server.rows}×${file.server.cols} but the room is ${file.height / FINENESS}×${file.width / FINENESS} squares`);
    }
  } else if (file.serverExtra.byteLength > 0) {
    warn(`${file.serverExtra.byteLength} bytes in the server section, which ${profile.name} ignores`);
  }
  if (file.roomId === null) warn("no RoomID after the things");

  return issues;
}

function checkReferences(file: RooFile, error: (message: string) => void): void {
  const nodes = file.nodes.length;
  const walls = file.clientWalls.length;
  const sidedefs = file.sidedefs.length;
  const sectors = file.sectors.length;
  const inRange = (v: number, max: number): boolean => v >= 0 && v <= max;

  file.nodes.forEach((n, i) => {
    if (n.type === "internal") {
      if (!inRange(n.posChild, nodes) || !inRange(n.negChild, nodes)) error(`node ${i + 1} has a child out of range`);
      if (!inRange(n.firstWall, walls)) error(`node ${i + 1} points at wall ${n.firstWall} of ${walls}`);
    } else {
      if (!inRange(n.sector, sectors)) error(`leaf ${i + 1} points at sector ${n.sector} of ${sectors}`);
      if (n.points.length < 3) error(`leaf ${i + 1} has ${n.points.length} points`);
    }
  });
  file.clientWalls.forEach((w, i) => {
    if (!inRange(w.next, walls)) error(`client wall ${i + 1} links to wall ${w.next} of ${walls}`);
    if (!inRange(w.posSidedef, sidedefs) || !inRange(w.negSidedef, sidedefs)) error(`client wall ${i + 1} has a sidedef out of range`);
    if (!inRange(w.posSector, sectors) || !inRange(w.negSector, sectors)) error(`client wall ${i + 1} has a sector out of range`);
  });
  file.editorWalls.forEach((w, i) => {
    if (!inRange(w.sidedef1, sidedefs) || !inRange(w.sidedef2, sidedefs)) error(`editor wall ${i + 1} has a sidedef out of range`);
    if (w.sector1 < -1 || w.sector1 >= sectors || w.sector2 < -1 || w.sector2 >= sectors) {
      error(`editor wall ${i + 1} has a sector out of range`);
    }
  });
}

function hex(v: number): string {
  return `0x${(v >>> 0).toString(16).padStart(8, "0")}`;
}
