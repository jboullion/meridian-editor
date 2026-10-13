// Locates the shipped reference rooms. They are never committed here; point
// ROO_ORIGINAL_DIR / ROO_104_DIR (path-delimiter separated lists) at a copy,
// or keep meridian-unreal's ReferenceServers checkout beside this repo.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { delimiter, join, relative } from "node:path";

const REFERENCE_SERVERS = "E:/2026_Experiments/meridian-unreal/ReferenceServers";

const DEFAULT_DIRS = {
  original: [join(REFERENCE_SERVERS, "MeridianSteam/Meridian59/resource/rooms")],
  "104": [join(REFERENCE_SERVERS, "Server-104/resource/rooms"), join(REFERENCE_SERVERS, "Server-104/roomedit/roogen")],
};

export type ReferenceSet = keyof typeof DEFAULT_DIRS;

/** Reference files whose stored checksum doesn't match their contents. */
export const KNOWN_BAD_SECURITY = new Set(["_t.roo"]);

export interface ReferenceRoom {
  name: string;
  path: string;
  bytes: () => Uint8Array;
}

export function referenceDirs(set: ReferenceSet): string[] {
  const env = process.env[set === "original" ? "ROO_ORIGINAL_DIR" : "ROO_104_DIR"];
  const dirs = env ? env.split(delimiter).filter(Boolean) : DEFAULT_DIRS[set];
  return dirs.filter((d) => existsSync(d));
}

export function referenceRooms(set: ReferenceSet): ReferenceRoom[] {
  const rooms: ReferenceRoom[] = [];
  for (const dir of referenceDirs(set)) {
    for (const path of walk(dir)) {
      rooms.push({ name: relative(dir, path).replaceAll("\\", "/"), path, bytes: () => new Uint8Array(readFileSync(path)) });
    }
  }
  return rooms;
}

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir).sort()) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) yield* walk(path);
    else if (entry.toLowerCase().endsWith(".roo")) yield path;
  }
}

/** Index and a short hex window around the first byte where a and b differ, or null if equal. */
export function firstDifference(a: Uint8Array, b: Uint8Array): string | null {
  const n = Math.min(a.byteLength, b.byteLength);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return `byte ${i}: ${window(a, i)} vs ${window(b, i)}`;
  }
  if (a.byteLength !== b.byteLength) return `length ${a.byteLength} vs ${b.byteLength}`;
  return null;
}

function window(bytes: Uint8Array, at: number): string {
  return Array.from(bytes.subarray(at, at + 8), (b) => b.toString(16).padStart(2, "0")).join(" ");
}
