// The two output targets. A room source is compiled for one of them; the
// profile decides the version, and with it the checksum rule, the slope
// origin encoding and whether server grids are written (see versionEncoding),
// plus what the target's client and server can't load.

import { WF } from "./model.ts";

export type TargetName = "original" | "104";

export interface TargetProfile {
  name: TargetName;
  description: string;
  /** The version written. */
  version: number;
  /** Versions in the same family that this target's client and server load. */
  readableVersions: readonly number[];
  /** Sidedef flag bits the target understands. */
  wallFlagMask: number;
  /** 104's client and server reject any thing count other than 2. */
  exactlyTwoThings: boolean;
  /** 104 reads heights as unsigned, so negative heights load wrong. */
  allowNegativeHeights: boolean;
}

export const PROFILES: Readonly<Record<TargetName, TargetProfile>> = {
  original: {
    name: "original",
    description: "Original server (MeridianSteam): ROO v13 with server grids",
    version: 13,
    readableVersions: [12, 13],
    wallFlagMask: 0x7fff | WF.TRANSLUCENCY_MASK | WF.NO_HTILE,
    exactlyTwoThings: false,
    allowNegativeHeights: true,
  },
  "104": {
    name: "104",
    description: "Server 104 and Shards: ROO v15, no server section",
    version: 15,
    readableVersions: [14, 15],
    wallFlagMask: 0x7fff,
    exactlyTwoThings: true,
    allowNegativeHeights: false,
  },
};

export function getProfile(name: string): TargetProfile {
  if (name === "original" || name === "104") return PROFILES[name];
  throw new Error(`unknown target "${name}" (expected "original" or "104")`);
}

/** The target whose family a file version belongs to. */
export function profileForVersion(version: number): TargetProfile {
  return version >= 14 ? PROFILES["104"] : PROFILES.original;
}
