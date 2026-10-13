// Where the local Shards stack lives, and how to talk to its blakserv.
//
// meridian-browser (the Shards repo) is found beside this repo, or at
// MERIDIAN_BROWSER. Its server runs from server/src/run/server, its clients load
// game files from dist/assets (listed in manifest.json), and blakserv takes admin
// commands on the maintenance port (localhost:9998, commands end with CR).

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
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

// ---------------------------------------------------------------- the maintenance port

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
        await sleep(300);
        out = "";
        for (const c of commands) {
          sock.write(c + "\r");
          // Long commands (reload system) keep printing; wait until the output settles.
          let last = -1;
          for (let waited = 0; waited < 120_000 && (out.length === 0 || out.length !== last); waited += 400) {
            last = out.length;
            await sleep(400);
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

export async function findRoom(rid: number): Promise<number | null> {
  const [out] = await maint(`send object 0 FindRoomByNum num int ${rid}`);
  return returnedObject(out ?? "");
}

// ---------------------------------------------------------------- the asset manifest

interface Manifest {
  generated: string;
  files: Record<string, { size: number; hash: string; mtime: number }>;
}

/**
 * Put a file in dist/assets and list it in the manifest, the way build-assets.ts
 * does. `mtime` is the source file's (the server's copy), so a later
 * `npm run assets` sees it as up to date.
 */
export function publishAsset(name: string, bytes: Uint8Array, mtime: number): void {
  writeFileSync(join(ASSETS, name), bytes);
  const path = join(ASSETS, "manifest.json");
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
