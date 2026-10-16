// Where the Shards stack keeps what the editor works on, for a development checkout:
// meridian-browser beside this repo (or MERIDIAN_BROWSER), its server/src junction to
// the shards-server repository (or SHARDS_SERVER), and its asset build. Shared by the
// Electron main process, the Vite dev server, the agent and tools/shards.
//
// - rooms: shards-server's resource/rooms/src, the room sources (committed there)
// - roo: shards-server's resource/rooms, the compiled .roo files the server build copies
// - kod: shards-server's kod
// - run: the server's run folder (what blakserv loads)
// - assets: meridian-browser's dist/assets, the game files clients get (textures too)

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

export interface ShardsPaths {
  browser: string;
  server: string;
  rooms: string;
  roo: string;
  kod: string;
  run: string;
  assets: string;
}

/** `repoRoot` is this repo's root ("" when installed, which has no Shards beside it). */
export function shardsPaths(repoRoot: string): ShardsPaths | null {
  const browser = process.env.MERIDIAN_BROWSER ?? (repoRoot ? resolve(repoRoot, "..", "meridian-browser") : "");
  const server = process.env.SHARDS_SERVER ?? (browser ? join(browser, "server", "src") : "");
  if (!server || !existsSync(join(server, "kod"))) return null;
  return {
    browser,
    server,
    rooms: join(server, "resource", "rooms", "src"),
    roo: join(server, "resource", "rooms"),
    kod: join(server, "kod"),
    run: join(server, "run", "server"),
    assets: process.env.SHARDS_ASSETS ?? join(browser, "dist", "assets"),
  };
}

/** The rooms folder to open by default: Shards' room sources, else this repo's rooms/ */
export function defaultRoomsDir(repoRoot: string): string {
  const shards = shardsPaths(repoRoot)?.rooms;
  return shards && existsSync(shards) ? shards : join(repoRoot, "rooms");
}
