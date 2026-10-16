// Saving a Shards room puts it in the game: the source is compiled for 104 and
// the .roo goes everywhere it's read from, then blakserv rebuilds the rooms that
// use it. Players in them are put back where they stood (room.kod Recreate), and
// Shards' client sees the new checksum and loads the room again in place.
//
// - shards-server's resource/rooms/<name>.roo: committed beside the source, and
//   what the server build copies;
// - the run folder's rooms/<name>.roo: what blakserv loads;
// - meridian-browser's dist/assets, listed in the manifest: what clients load.
//
// Only rooms whose source is in Shards' rooms folder are installed, and only
// their geometry: a new room or a Kod change still goes through
// tools/shards/install.ts (it builds and reloads the Kod, which saves the game).
// Node only; shared by the Electron main process and the Vite dev server.

import { existsSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { getProfile } from "@meridian-editor/roo";
import { compileRoom, parseRoomSource } from "@meridian-editor/roomc";
import { buildKodIndex } from "../renderer/kod/kodRooms.ts";
import { readKodSources } from "./kod.ts";
import { findRooms, maint, publishAsset } from "./shardsServer.ts";
import { shardsPaths } from "./shardsPaths.ts";

const SUFFIX = ".room.json";

export interface InstallResult {
  /** The room file, e.g. "tos.roo" */
  roo: string;
  bytes: number;
  /** The room numbers that use it, and the room object each was rebuilt as (null: not loaded on the server) */
  rooms: { rid: number; recreated: boolean }[];
  /** Why the server wasn't told, if it wasn't (not running) */
  serverError: string | null;
  ms: number;
}

/** Whether a saved file is one of Shards' room sources (so saving it can install it). */
export function isShardsRoom(repoRoot: string, path: string): boolean {
  const rooms = shardsPaths(repoRoot)?.rooms;
  if (!rooms || !path.toLowerCase().endsWith(SUFFIX)) return false;
  const same = (a: string, b: string) => (process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b);
  return same(dirname(resolve(path)), resolve(rooms));
}

/** Compile `text` (the source saved at `path`) and put it on the local Shards stack. */
export async function installRoom(repoRoot: string, path: string, text: string): Promise<InstallResult> {
  const t0 = Date.now();
  const paths = shardsPaths(repoRoot);
  if (!paths || !isShardsRoom(repoRoot, path)) throw new Error(`${basename(path)} isn't one of Shards' rooms (${paths?.rooms ?? "no Shards checkout"})`);
  const name = basename(path).slice(0, -SUFFIX.length).toLowerCase();
  const source = parseRoomSource(text);
  const { bytes, diagnostics } = compileRoom(source, getProfile("104"));
  const errors = diagnostics.filter((d) => d.severity === "error");
  if (errors.length) throw new Error(`${name} doesn't compile: ${errors.map((d) => d.message).join("; ")}`);

  const roo = `${name}.roo`;
  writeFileSync(join(paths.roo, roo), bytes);
  const runRoo = join(paths.run, "rooms", roo);
  if (existsSync(dirname(runRoo))) writeFileSync(runRoo, bytes);
  if (existsSync(join(paths.assets, "manifest.json"))) publishAsset(paths.assets, roo, bytes, existsSync(runRoo) ? statSync(runRoo).mtimeMs : Date.now());

  // Every class built from this file (tos.roo: Tos, DeathRealmTos ...), and the source's own number
  const kod = await readKodSources(paths.kod, repoRoot);
  const index = buildKodIndex(kod.dir, kod.files, kod.khd);
  const rids = [...new Set([source.roomId, ...(index.byRoo.get(roo) ?? []).map((r) => r.rid)].filter((r): r is number => !!r))];

  let serverError: string | null = null;
  const rooms: InstallResult["rooms"] = [];
  try {
    const objects = await findRooms(rids);
    const recreate = objects.flatMap((o) => (o === null ? [] : [`send object ${o} Recreate`]));
    if (recreate.length) await maint(...recreate);
    rids.forEach((rid, i) => rooms.push({ rid, recreated: objects[i] !== null }));
  } catch (e) {
    serverError = (e as Error).message;
    for (const rid of rids) rooms.push({ rid, recreated: false });
  }
  return { roo, bytes: bytes.length, rooms, serverError, ms: Date.now() - t0 };
}
