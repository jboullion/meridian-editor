// The room folder: lists and reads room sources. Shared by the Electron main
// process and the Vite dev server's /api/rooms (for running the UI in a browser).

import { readdir, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

export interface RoomEntry {
  /** Host-specific id: an absolute path in Electron, a folder-relative path in the browser. */
  id: string;
  /** Path relative to the rooms folder, with forward slashes. */
  path: string;
  name: string;
}

export const ROOM_SUFFIX = ".room.json";

/** Every *.room.json under `dir`, sorted with top-level rooms first. */
export async function listRooms(dir: string): Promise<{ path: string; name: string; abs: string }[]> {
  const out: { path: string; name: string; abs: string }[] = [];
  const walk = async (d: string): Promise<void> => {
    let entries: string[];
    try {
      entries = await readdir(d);
    } catch {
      return;
    }
    for (const e of entries) {
      const abs = join(d, e);
      if ((await stat(abs)).isDirectory()) await walk(abs);
      else if (e.toLowerCase().endsWith(ROOM_SUFFIX)) {
        const path = relative(dir, abs).split(sep).join("/");
        out.push({ path, name: e.slice(0, -ROOM_SUFFIX.length), abs });
      }
    }
  };
  await walk(dir);
  const depth = (p: string): number => p.split("/").length;
  return out.sort((a, b) => depth(a.path) - depth(b.path) || a.path.localeCompare(b.path, undefined, { sensitivity: "base" }));
}

/** Resolve a folder-relative path, refusing anything that escapes the folder. */
export function resolveInside(dir: string, path: string): string {
  const root = resolve(dir);
  const abs = resolve(root, path);
  if (abs !== root && !abs.startsWith(root + sep)) throw new Error(`path escapes the rooms folder: ${path}`);
  return abs;
}
