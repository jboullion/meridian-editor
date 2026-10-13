// The server's Kod source, for showing where a room's Kod puts things. Reads
// the room classes (object/active/holder/room/**.kod) and the RID constants
// (include/blakston.khd). By default the Shards server's copy beside this repo:
// meridian-browser/server/src/kod. Shared by the Electron main process and the
// Vite dev server's /api/kod.

import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

const ROOM_CLASSES = join("object", "active", "holder", "room");
const KHD = join("include", "blakston.khd");

/** `repoRoot` is this repo's root; the Shards repo is expected beside it. */
export function defaultKodDir(repoRoot: string): string {
  // Installed (no repo), only EDITOR_KOD_DIR or the folder set in Preferences.
  const candidates = [process.env.EDITOR_KOD_DIR, repoRoot && resolve(repoRoot, "..", "meridian-browser", "server", "src", "kod")].filter((d): d is string => !!d);
  return candidates.find((d) => existsSync(join(d, KHD))) ?? "";
}

export interface KodSources {
  dir: string;
  files: { path: string; text: string }[];
  /** Object classes that give light: the flickerers (candles, braziers, lamps ...) and ornaments. */
  objectFiles: { path: string; text: string }[];
  khd: string;
}

const LIGHT_OBJECTS = [
  join("object", "passive", "flikerer.kod"),
  join("object", "passive", "flikerer"),
  join("object", "passive", "ornobj.kod"),
  join("object", "passive", "sign.kod"),
  join("object", "passive", "news.kod"),
  join("object", "passive", "newslink.kod"),
];

export async function readKodSources(dir: string, repoRoot: string): Promise<KodSources> {
  const root = dir || defaultKodDir(repoRoot);
  if (!root || !existsSync(join(root, KHD))) return { dir: root, files: [], objectFiles: [], khd: "" };
  const read = async (path: string, out: KodSources["files"]): Promise<void> => {
    if (!existsSync(path)) return;
    if ((await stat(path)).isDirectory()) {
      for (const e of await readdir(path)) await read(join(path, e), out);
    } else if (path.toLowerCase().endsWith(".kod")) {
      // Kod is Latin-1, like the rest of the game's text.
      out.push({ path: relative(root, path).split(sep).join("/"), text: await readFile(path, "latin1") });
    }
  };
  const files: KodSources["files"] = [];
  await read(join(root, ROOM_CLASSES), files);
  const objectFiles: KodSources["files"] = [];
  for (const p of LIGHT_OBJECTS) await read(join(root, p), objectFiles);
  return { dir: root, files, objectFiles, khd: await readFile(join(root, KHD), "latin1") };
}
