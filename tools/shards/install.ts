// Put a room from rooms/new into the local Shards stack and load it on the
// running server.
//
//   node tools/shards/install.ts edtest
//
// 1. Compiles rooms/new/<name>.room.json for 104 (rooms/out/<name>.roo).
// 2. Copies the .roo to the server's rooms folder and to dist/assets, listed in
//    the manifest, so the server and the clients have the same file.
// 3. If rooms/new/<name>.kod changed: copies it into the server's Kod tree, adds
//    it to the room makefile, builds the Kod (server\build.cmd Bkod), reloads
//    blakserv's Kod ("reload system") and rebuilds the assets (the client needs
//    the new rsc0000.rsb for the room's name and file).
// 4. Creates the room object on the server, or recreates it so it loads the new
//    .roo (players in it go along).

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getProfile } from "@meridian-editor/roo";
import { compileRoom, parseRoomSource } from "@meridian-editor/roomc";
import { BROWSER, findRoom, maint, publishAsset, REPO, requireBrowser, ROOM_KOD_DIR, RUN } from "./shards.ts";

const name = process.argv[2];
if (!name || !/^\w+$/.test(name)) {
  console.error("usage: node tools/shards/install.ts <room name in rooms/new>");
  process.exit(2);
}
requireBrowser();

// 1. Compile.
const srcPath = join(REPO, "rooms", "new", `${name}.room.json`);
const source = parseRoomSource(readFileSync(srcPath, "utf8"));
const { bytes, diagnostics } = compileRoom(source, getProfile("104"));
for (const d of diagnostics) console.log(`${d.severity}: ${d.message}`);
if (diagnostics.some((d) => d.severity === "error")) process.exit(1);
mkdirSync(join(REPO, "rooms", "out"), { recursive: true });
writeFileSync(join(REPO, "rooms", "out", `${name}.roo`), bytes);
const rid = source.roomId;
if (!rid) throw new Error(`${name}.room.json has no roomId`);

// 2. The server's copy and the clients' copy.
const roo = `${name}.roo`;
const serverRoo = join(RUN, "rooms", roo);
writeFileSync(serverRoo, bytes);
publishAsset(roo, bytes, statSync(serverRoo).mtimeMs);
console.log(`${roo}: ${bytes.length} bytes to the server and dist/assets`);

// 3. Kod.
const kodPath = join(REPO, "rooms", "new", `${name}.kod`);
const kod = readFileSync(kodPath, "utf8");
const className = /^(\w+) is Room\b/m.exec(kod)?.[1];
if (!className) throw new Error(`${kodPath} doesn't declare "<Class> is Room"`);
const serverKod = join(ROOM_KOD_DIR, `${name}.kod`);
const crlf = kod.replace(/\r?\n/g, "\r\n");
if (!existsSync(serverKod) || readFileSync(serverKod, "utf8") !== crlf) {
  writeFileSync(serverKod, crlf);
  addToMakefile(join(ROOM_KOD_DIR, "makefile"), `${name}.bof`);
  console.log(`${name}.kod: building the Kod`);
  run("cmd", ["/c", join(BROWSER, "server", "build.cmd"), "Bkod"], BROWSER);
  console.log("reload system (blakserv saves the game and reloads the Kod)");
  const [out] = await maint("reload system");
  if (!/reload/i.test(out ?? "")) console.log(out);
  console.log("npm run assets (the new rsc0000.rsb for the clients)");
  run("npm run assets", [], BROWSER);
}

// 4. The room object.
const existing = await findRoom(rid);
if (existing === null) {
  const [created] = await maint(`create object ${className}`);
  const id = /Created object (\d+)/.exec(created ?? "")?.[1];
  if (!id) throw new Error(`create object ${className} failed:\n${created}`);
  await maint(`send object 0 ReattachRoom oRoom object ${id}`);
  console.log(`created room ${className} (RID ${rid}) as object ${id}`);
} else {
  await maint(`send object ${existing} Recreate`);
  console.log(`recreated room RID ${rid} (was object ${existing}) with the new ${roo}`);
}
const now = await findRoom(rid);
if (now === null) throw new Error(`RID ${rid} isn't registered on the server`);
console.log(`RID ${rid} is object ${now}. Admin: send object <player> TeleportTo RID int ${rid}`);

function addToMakefile(path: string, bof: string): void {
  const text = readFileSync(path, "utf8");
  if (new RegExp(`\\b${bof.replace(".", "\\.")}\\b`).test(text)) return;
  // The BOFS list: "BOFS = a.bof b.bof \" continued over lines ending in a backslash.
  const m = /^BOFS\s*=(?:[^\r\n]*\\\r?\n)*[^\r\n]*/m.exec(text);
  if (!m) throw new Error(`no BOFS list in ${path}`);
  const end = m.index + m[0].length;
  writeFileSync(path, `${text.slice(0, end)} \\\r\n   ${bof}${text.slice(end)}`);
}

function run(cmd: string, args: string[], cwd: string): void {
  // npm is a script on Windows, so it goes through the shell as one command line.
  const r = args.length ? spawnSync(cmd, args, { cwd, stdio: "inherit" }) : spawnSync(cmd, { cwd, stdio: "inherit", shell: true });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed (exit ${r.status})`);
}
