// Put a room on the local Shards stack and load it on the running server.
//
//   node tools/shards/install.ts <room> [--yes]
//
// A Shards room (its source in shards-server's resource/rooms/src, its Kod class in
// shards-server's kod tree, both committed there):
// 1. The geometry, as saving it in the editor does (src/main/shardsInstall.ts): compiled,
//    the .roo written beside the source, to the run folder and to dist/assets, and every
//    room built from it rebuilt on the server.
// 2. If the server doesn't have the room yet (a new room): checks that its Kod is
//    registered (the class's .bof in its makefile, its RID_ in blakston.khd, a
//    CreateOneRoomIfNew line in system.kod), builds the Kod (server\build.cmd Bkod),
//    reloads it ("reload system", which saves the game: asked first unless --yes),
//    creates the room (System.CreateOneRoomIfNew) and rebuilds the assets (the clients
//    need the new rsc0000.rsb for the room's name and file, and rooms.json).
//
// The editor's own test room (rooms/new/edtest, with its .kod beside it) goes the old way:
// its .kod is copied into the server's Kod tree and added to the room makefile first.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { createInterface } from "node:readline/promises";
import { getProfile } from "@meridian-editor/roo";
import { compileRoom, parseRoomSource } from "@meridian-editor/roomc";
import { installRoom } from "../../apps/editor/src/main/shardsInstall.ts";
import { shardsPaths } from "../../apps/editor/src/main/shardsPaths.ts";
import { BROWSER, findRoom, maint, publishAsset, REPO, requireBrowser, ROOM_KOD_DIR, RUN } from "./shards.ts";

const name = process.argv[2];
const yes = process.argv.includes("--yes");
if (!name || !/^\w+$/.test(name)) {
  console.error("usage: node tools/shards/install.ts <room> [--yes]");
  process.exit(2);
}
requireBrowser();
const paths = shardsPaths(REPO);
if (!paths) throw new Error("No Shards server beside this repo");

const shardsSource = join(paths.rooms, `${name}.room.json`);
if (existsSync(shardsSource)) await installShardsRoom();
else await installEditorRoom();

async function installShardsRoom(): Promise<void> {
  // 1. The geometry
  const r = await installRoom(REPO, shardsSource, readFileSync(shardsSource, "utf8"));
  if (r.serverError) throw new Error(r.serverError);
  console.log(`${r.roo}: ${r.bytes} bytes; rooms ${r.rooms.map((x) => `${x.rid}${x.recreated ? " rebuilt" : " not loaded"}`).join(", ") || "(none found in the Kod)"}`);
  if (r.rooms.length && r.rooms.every((x) => x.recreated)) return;

  // 2. A new room: its class, its number and its registration
  const roo = `${name}.roo`;
  const kod = findRoomClass(roo);
  if (!kod) throw new Error(`No Kod class uses ${roo}: write one in ${relative(paths!.server, ROOM_KOD_DIR)} (provgrnd.kod is an example)`);
  const khd = readFileSync(join(paths!.kod, "include", "blakston.khd"), "latin1");
  const rid = kod.ridName ? Number(new RegExp(`^\\s*${kod.ridName}\\s*=\\s*(\\d+)`, "m").exec(khd)?.[1]) : Number(kod.rid);
  const problems: string[] = [];
  if (!rid) problems.push(`${kod.className} has no piRoom_num (or its RID_ isn't in blakston.khd)`);
  const makefile = readFileSync(join(kod.dir, "makefile"), "latin1");
  const bof = kod.file.replace(/\.kod$/i, ".bof");
  if (!new RegExp(`\\b${bof.replace(".", "\\.")}\\b`, "i").test(makefile)) problems.push(`${bof} isn't in ${relative(paths!.server, join(kod.dir, "makefile"))}'s BOFS`);
  const system = readFileSync(join(paths!.kod, "util", "system.kod"), "latin1");
  if (!new RegExp(`CreateOneRoomIfNew,#num=(${kod.ridName ?? rid}),#class=&${kod.className}\\b`, "i").test(system)) {
    problems.push(`util/system.kod's CreateAllRoomsIfNew has no Send(self,@CreateOneRoomIfNew,#num=${kod.ridName ?? rid},#class=&${kod.className});`);
  }
  if (problems.length) throw new Error(`${kod.className} isn't registered yet:\n  ${problems.join("\n  ")}`);

  console.log(`${kod.className} (RID ${rid}) is new to the server: building the Kod`);
  run("cmd", ["/c", join(BROWSER, "server", "build.cmd"), "Bkod"], BROWSER);
  if (!(await confirm('"reload system" saves the game and reloads all the Kod. Go ahead?'))) {
    console.log('Stopped. Later: node tools/maint/maint.ts "reload system", then run this again.');
    return;
  }
  const [out] = await maint("reload system");
  if (!/reload/i.test(out ?? "")) console.log(out);
  await maint(`send object 0 CreateOneRoomIfNew num int ${rid} class class ${kod.className}`);
  const now = await findRoom(rid);
  if (now === null) throw new Error(`RID ${rid} still isn't on the server: look at the run folder's channel/error.txt`);
  console.log(`created ${kod.className} (RID ${rid}) as object ${now}`);
  console.log("npm run assets (the new rsc0000.rsb, rooms.json and the room's exits for the clients)");
  run("npm run assets", [], BROWSER);
  console.log(`Done. Reload the game's page (rsc0000.rsb changed), then: send object <player> TeleportTo RID int ${rid}`);
}

/** The Kod class whose prRoom is this .roo: its file, folder, class name and room number */
function findRoomClass(roo: string): { file: string; dir: string; className: string; ridName: string | null; rid: string | null } | null {
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith(".kod") ? [join(dir, e.name)] : []));
  for (const path of walk(ROOM_KOD_DIR)) {
    const text = readFileSync(path, "latin1");
    if (!new RegExp(`^\\s*\\w+\\s*=\\s*${roo.replace(".", "\\.")}\\s*$`, "im").test(text)) continue;
    const className = /^(\w+) is \w+/m.exec(text)?.[1];
    const num = /piRoom_num\s*=\s*(\w+)/.exec(text)?.[1] ?? null;
    if (!className) continue;
    return { file: path.split(/[\\/]/).pop()!, dir: join(path, ".."), className, ridName: num && !/^\d+$/.test(num) ? num : null, rid: num && /^\d+$/.test(num) ? num : null };
  }
  return null;
}

async function confirm(question: string): Promise<boolean> {
  if (yes) return true;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`${question} [y/N] `);
  rl.close();
  return /^y/i.test(answer.trim());
}

/** The editor's test room, rooms/new/<name>: its .kod is copied into the server's tree */
async function installEditorRoom(): Promise<void> {
  const srcPath = join(REPO, "rooms", "new", `${name}.room.json`);
  if (!existsSync(srcPath)) throw new Error(`No ${name}.room.json in ${paths!.rooms} or rooms/new`);
  const source = parseRoomSource(readFileSync(srcPath, "utf8"));
  const { bytes, diagnostics } = compileRoom(source, getProfile("104"));
  for (const d of diagnostics) console.log(`${d.severity}: ${d.message}`);
  if (diagnostics.some((d) => d.severity === "error")) process.exit(1);
  mkdirSync(join(REPO, "rooms", "out"), { recursive: true });
  writeFileSync(join(REPO, "rooms", "out", `${name}.roo`), bytes);
  const rid = source.roomId;
  if (!rid) throw new Error(`${name}.room.json has no roomId`);

  const roo = `${name}.roo`;
  const serverRoo = join(RUN, "rooms", roo);
  writeFileSync(serverRoo, bytes);
  publishAsset(roo, bytes, statSync(serverRoo).mtimeMs);
  console.log(`${roo}: ${bytes.length} bytes to the server and dist/assets`);

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
    if (!(await confirm('"reload system" saves the game and reloads all the Kod. Go ahead?'))) return;
    const [out] = await maint("reload system");
    if (!/reload/i.test(out ?? "")) console.log(out);
    console.log("npm run assets (the new rsc0000.rsb for the clients)");
    run("npm run assets", [], BROWSER);
  }

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
}

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
