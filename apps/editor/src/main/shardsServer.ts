// Talking to the local Shards stack: blakserv's maintenance port (localhost:9998,
// commands end with CR) and the clients' game files (dist/assets, listed in
// manifest.json). Node only; shared by the Electron main process, the Vite dev
// server (the web build) and tools/shards.

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";

const MAINT_PORT = Number(process.env.MAINT_PORT ?? 9998);

/** Run admin commands on the local blakserv; returns each command's output. */
export function maint(...commands: string[]): Promise<string[]> {
  return new Promise((done, fail) => {
    const sock = connect({ host: "127.0.0.1", port: MAINT_PORT });
    let out = "";
    const results: string[] = [];
    sock.on("data", (d) => (out += d.toString("latin1")));
    sock.on("error", (e) => fail(new Error(`maintenance port ${MAINT_PORT}: ${e.message}. Is blakserv running?`)));
    const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
    sock.on("connect", () => {
      void (async () => {
        // The greeting comes first; it isn't any command's output
        await sleep(150);
        out = "";
        for (const c of commands) {
          sock.write(c + "\r");
          // Long commands (reload system) keep printing; wait until the output settles.
          let last = -1;
          for (let waited = 0; waited < 120_000 && (out.length === 0 || out.length !== last); waited += 150) {
            last = out.length;
            await sleep(150);
          }
          results.push(out.replace(/\r/g, ""));
          out = "";
        }
        sock.end();
        done(results);
      })();
    });
  });
}

/** The object a `send object` returned: an object id, or null for $. */
export function returnedObject(output: string): number | null {
  const m = /^: OBJECT (\d+)/m.exec(output);
  return m ? Number(m[1]) : null;
}

/** The room objects for some room numbers (null where none is loaded: an instanced room, or a typo), in one connection. */
export async function findRooms(rids: readonly number[]): Promise<(number | null)[]> {
  if (!rids.length) return [];
  const outs = await maint(...rids.map((rid) => `send object 0 FindRoomByNum num int ${rid}`));
  return outs.map((o) => returnedObject(o));
}

export async function findRoom(rid: number): Promise<number | null> {
  return (await findRooms([rid]))[0] ?? null;
}

interface Manifest {
  generated: string;
  files: Record<string, { size: number; hash: string; mtime: number }>;
}

/**
 * Put a file in dist/assets and list it in the manifest, the way build-assets.ts
 * does. `mtime` is the source file's (the server's copy), so a later
 * `npm run assets` sees it as up to date.
 */
export function publishAsset(assets: string, name: string, bytes: Uint8Array, mtime: number): void {
  writeFileSync(join(assets, name), bytes);
  const path = join(assets, "manifest.json");
  const manifest = JSON.parse(readFileSync(path, "utf8")) as Manifest;
  manifest.files[name.toLowerCase()] = {
    size: bytes.length,
    hash: createHash("sha1").update(bytes).digest("hex").slice(0, 16),
    mtime,
  };
  // A new `generated` tells running clients the game files changed.
  manifest.generated = new Date().toISOString();
  writeFileSync(path, JSON.stringify(manifest));
}
