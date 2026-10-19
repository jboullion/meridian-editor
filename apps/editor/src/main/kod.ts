// The server's Kod source, for showing where a room's Kod puts things. Reads
// the room classes (object/active/holder/room/**.kod) and the RID constants
// (include/blakston.khd). By default the Shards server's (shardsPaths.ts: shards-server's
// kod, through meridian-browser/server/src). Shared by the Electron main process and the
// Vite dev server's /api/kod. writeKodFile saves the editor's changes to a room
// class (its exits) back into the same folder.

import { existsSync } from "node:fs";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { resolveInside } from "./roomsFs.ts";
import { shardsPaths } from "./shardsPaths.ts";

const ROOM_CLASSES = join("object", "active", "holder", "room");
const KHD = join("include", "blakston.khd");

/** `repoRoot` is this repo's root; the Shards repo is expected beside it. */
export function defaultKodDir(repoRoot: string): string {
  // Installed (no repo), only EDITOR_KOD_DIR or the folder set in Preferences.
  const candidates = [process.env.EDITOR_KOD_DIR, shardsPaths(repoRoot)?.kod].filter((d): d is string => !!d);
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

/**
 * Save a room class the editor changed: an existing .kod among the room classes
 * of the Kod folder `dir` ("" for the default), by its path there. `base` is the
 * text the change was made to; if the file no longer has it, nothing is written.
 */
export async function writeKodFile(dir: string, path: string, text: string, base: string, repoRoot: string): Promise<void> {
  const root = dir || defaultKodDir(repoRoot);
  if (!root || !existsSync(join(root, KHD))) throw new Error(`${root || "No Kod folder"} isn't a Kod folder (no include/blakston.khd)`);
  if (!path.toLowerCase().endsWith(".kod")) throw new Error(`${path} isn't a .kod file`);
  const abs = resolveInside(join(root, ROOM_CLASSES), relative(ROOM_CLASSES, path));
  if (!existsSync(abs)) throw new Error(`${path} isn't in ${root}`);
  // Latin-1, as it was read.
  if ((await readFile(abs, "latin1")) !== base) throw new Error(`${path} changed on disk since the editor read it: Reload Kod, then make the change again`);
  await writeFile(abs, text, "latin1");
}
