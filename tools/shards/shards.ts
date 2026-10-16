// Where the local Shards stack lives, and how to talk to its blakserv.
//
// meridian-browser (the Shards repo) is found beside this repo, or at
// MERIDIAN_BROWSER. Its server runs from server/src/run/server, its clients load
// game files from dist/assets (listed in manifest.json), and blakserv takes admin
// commands on the maintenance port (localhost:9998, commands end with CR).

import { existsSync } from "node:fs";
import { publishAsset as publishAssetIn } from "../../apps/editor/src/main/shardsServer.ts";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const REPO = resolve(fileURLToPath(import.meta.url), "../../..");
export const BROWSER = resolve(process.env.MERIDIAN_BROWSER ?? join(REPO, "..", "meridian-browser"));
export const SERVER_SRC = join(BROWSER, "server", "src");
export const RUN = join(SERVER_SRC, "run", "server");
export const ASSETS = join(BROWSER, "dist", "assets");
export const ROOM_KOD_DIR = join(SERVER_SRC, "kod", "object", "active", "holder", "room");

export function requireBrowser(): void {
  for (const p of [BROWSER, RUN, ASSETS]) {
    if (!existsSync(p)) throw new Error(`${p} is missing. Set MERIDIAN_BROWSER to the Shards repo, with its server built and assets made.`);
  }
}

/** Import a module from the Shards repo (its protocol and format readers), by path. */
export async function browserModule<T>(path: string): Promise<T> {
  return (await import(pathToFileURL(join(BROWSER, path)).href)) as T;
}

// ---------------------------------------------------------------- the maintenance port and the manifest

// Shared with the editor app, which installs rooms on save (apps/editor/src/main/shardsServer.ts)
export { findRoom, maint, returnedObject } from "../../apps/editor/src/main/shardsServer.ts";

/** Put a file in dist/assets and list it in the manifest (shardsServer.ts publishAsset). */
export function publishAsset(name: string, bytes: Uint8Array, mtime: number): void {
  publishAssetIn(ASSETS, name, bytes, mtime);
}
