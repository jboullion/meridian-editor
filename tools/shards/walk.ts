// Walk a room on the local Shards server the way the Shards client does, and
// check what stops you, from a walk spec (rooms/new/<name>.walk.json).
//
//   node tools/shards/walk.ts edtest [--user shardpal] [--pass shardpal]
//
// Logs in through the gateway with meridian-browser's protocol code, has
// blakserv teleport the character into the room, and checks the room file and
// checksum the server names match ours. Then it walks each step: "to" a Kod
// square ("row,col", 1-based, its centre), or "go" to take the exit underfoot.
//
// Walls, steps and ceilings are the client's to enforce: Server 104's UserMove
// only refuses a spot outside every sector (s:kod/.../user.kod UserMove). So
// each step is walked by the Shards client's own movement code (PlayerMover, its
// port of clientd3d/move.c) on our compiled room, facing the target with the
// forward key held, and the moves it makes go to the server like the game's.
// A step expects to be "reached" (the default) or "blocked": the mover stopped
// short, or the server put us back (BP_MOVE). Exits 1 if any step didn't go as
// expected.
//
// Use a test account no one is playing on: logging in takes over its session.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { readRoo } from "@meridian-editor/roo";
import { browserModule, maint, REPO, requireBrowser, RUN, BROWSER } from "./shards.ts";

interface WalkStep {
  to?: string;
  go?: boolean;
  expect?: "reached" | "blocked";
  why?: string;
}

const { values: opt, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    user: { type: "string", default: "shardpal" },
    pass: { type: "string" },
    url: { type: "string", default: "ws://localhost:8059" },
    verbose: { type: "boolean", default: false },
  },
});
const name = positionals[0];
if (!name) {
  console.error("usage: node tools/shards/walk.ts <room name in rooms/new> [--user shardpal]");
  process.exit(2);
}
requireBrowser();

const spec = JSON.parse(readFileSync(join(REPO, "rooms", "new", `${name}.walk.json`), "utf8")) as { room: string; steps: WalkStep[] };
const rooBytes = new Uint8Array(readFileSync(join(RUN, "rooms", `${spec.room}.roo`)));
const ours = readRoo(rooBytes);
const rid = JSON.parse(readFileSync(join(REPO, "rooms", "new", `${spec.room}.room.json`), "utf8")).roomId as number;

// ---------------------------------------------------------------- meridian-browser's protocol

interface Reader {
  u8(): number;
  u16(): number;
  u32(): number;
  string(): string;
}
interface PlayerInfo {
  id: number;
  roomId: number;
  roomRes: number;
  roomNameRes: number;
  roomSecurity: number;
}
interface Protocol {
  AP: Record<string, number>;
  BP: Record<string, number>;
  KOD_FINENESS: number;
  SPEED_WALK: number;
  Connection: new (
    send: (b: Uint8Array) => void,
    handlers: { state: (s: string) => void; error: (e: Error) => void; message: (type: number, r: Reader, state: string) => void },
  ) => {
    token: { lookup: (id: number) => string | undefined };
    start(): void;
    receive(b: Uint8Array): void;
    sendLogin(b: Uint8Array): void;
    sendGame(b: Uint8Array): void;
    close(): void;
  };
  buildLogin(info: { username: string; passwordDigest: Uint8Array; secretKey: string }): Uint8Array;
  passwordDigest(p: string): Uint8Array;
  buildReqGame(): Uint8Array;
  buildSimple(type: number): Uint8Array;
  buildUseCharacter(id: number): Uint8Array;
  buildReqMove(row: number, col: number, speed: number, roomId: number): Uint8Array;
  readCharacters(r: Reader): { characters: { id: number; name: string; flags: number }[] };
  readPlayer(r: Reader): PlayerInfo;
  readRoomContents(r: Reader): { objects: { id: number; kodRow: number; kodCol: number }[] };
  readMove(r: Reader): { id: number; kodRow: number; kodCol: number };
}

interface Mover {
  x: number;
  y: number;
  angle: number;
  room: unknown;
  place(x: number, y: number, now: number): void;
  update(input: { forward: number; strafe: number; run: boolean }, dt: number, now: number, objects: Iterable<unknown>, selfId: number): void;
  flush(now: number): void;
}

const P = await browserModule<Protocol>("packages/protocol/src/index.ts");
const { PlayerMover } = await browserModule<{
  PlayerMover: new (sink: { move(x: number, y: number, speed: number): void; turn(angle: number): void }) => Mover;
}>("packages/world/src/movement.ts");
const { parseRoo } = await browserModule<{ parseRoo: (b: Uint8Array) => unknown }>("packages/formats/src/roo.ts");
const { parseRsb } = await browserModule<{ parseRsb: (b: Uint8Array) => { get(id: number): string | undefined } }>("packages/formats/src/rsb.ts");
const rsb = parseRsb(new Uint8Array(readFileSync(join(RUN, "rsc", "rsc0000.rsb"))));
const dynamicRsc = new Map<number, string>();
const rs = (id: number): string => dynamicRsc.get(id) ?? rsb.get(id) ?? `#${id}`;
const secretKey = /^SecretKey\s+(\S+)/m.exec(readFileSync(join(BROWSER, "server", "config", "blakserv.cfg"), "utf8"))?.[1];
if (!secretKey) throw new Error("no SecretKey in meridian-browser server/config/blakserv.cfg");

// ---------------------------------------------------------------- the session

const t0 = Date.now();
const log = (...a: unknown[]): void => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(5)}s]`, ...a);
const where = (): string => `${(1 + mover.y / 1024).toFixed(2)},${(1 + mover.x / 1024).toFixed(2)}`;

// Client fine units (1024 a square) <-> Kod fine units (64 a square, from 1): world/src/state.ts.
const kodToFine = (kod: number): number => (kod - 64) * 16;
const fineToKod = (fine: number): number => (fine >> 4) + 64;

let player: PlayerInfo | undefined;
const mover = new PlayerMover({
  move: (x, y, speed) => player && conn.sendGame(P.buildReqMove(fineToKod(y), fineToKod(x), speed, player.roomId)),
  turn: () => {},
});
/** Simulated client time, ms. */
let now = 0;
/** Set by BP_MOVE for us: the server put us somewhere else. */
let snapped: boolean;
let roomLoaded: (() => void) | undefined;
let playerChanged: (() => void) | undefined;

const ws = new WebSocket(opt.url!, ["binary"]);
ws.binaryType = "arraybuffer";
const conn = new P.Connection((b) => ws.send(b as Uint8Array<ArrayBuffer>), {
  state: (s) => opt.verbose && log(`state ${s}`),
  error: (e) => fail(`protocol error: ${e.message}`),
  message: (type, r, state) => (state === "login" ? onLogin(type, r) : onGame(type, r)),
});
conn.token.lookup = (id) => rsb.get(id);
ws.onopen = () => conn.start();
ws.onmessage = (ev) => conn.receive(new Uint8Array(ev.data as ArrayBuffer));
ws.onclose = () => finished || fail("the gateway closed the connection");
let finished = false;

function onLogin(type: number, r: Reader): void {
  if (type === P.AP.GETLOGIN) {
    conn.sendLogin(P.buildLogin({ username: opt.user!, passwordDigest: P.passwordDigest(opt.pass ?? opt.user!), secretKey: secretKey! }));
  } else if (type === P.AP.LOGINFAILED) fail(`login as ${opt.user} failed`);
  else if (type === P.AP.GETCHOICE && !finished) conn.sendLogin(P.buildReqGame());
  else if (type === P.AP.MESSAGE) log(`server: ${r.string()}`);
}

function onGame(type: number, r: Reader): void {
  switch (type) {
    case P.BP.LOAD_MODULE:
      if (/char/i.test(rs(r.u32()))) conn.sendGame(P.buildSimple(P.BP.SEND_CHARACTERS));
      break;
    case P.BP.CHARACTERS: {
      const c = P.readCharacters(r).characters.find((c) => c.flags !== 1);
      if (!c) return fail(`${opt.user} has no character`);
      conn.sendGame(P.buildUseCharacter(c.id));
      break;
    }
    case P.BP.PLAYER:
      player = P.readPlayer(r);
      log(`in "${rs(player.roomNameRes)}" (${rs(player.roomRes)}, room object ${player.roomId})`);
      playerChanged?.();
      break;
    case P.BP.ROOM_CONTENTS: {
      const self = P.readRoomContents(r).objects.find((o) => o.id === player?.id);
      if (self) mover.place(kodToFine(self.kodCol), kodToFine(self.kodRow), now);
      roomLoaded?.();
      break;
    }
    case P.BP.MOVE: {
      const m = P.readMove(r);
      if (m.id === player?.id) {
        mover.place(kodToFine(m.kodCol), kodToFine(m.kodRow), now);
        snapped = true;
        if (opt.verbose) log(`server moved us to ${where()}`);
      }
      break;
    }
    case P.BP.CHANGE_RESOURCE: {
      const id = r.u32();
      dynamicRsc.set(id, r.string());
      break;
    }
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
function waitFor(what: string, set: (resolve: () => void) => void, ms = 15000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), ms);
    set(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function fail(message: string): never {
  console.error(`FAILED: ${message}`);
  finished = true;
  conn.close();
  ws.close();
  process.exit(1);
}

// ---------------------------------------------------------------- the walk

await waitFor("entering the game", (done) => (roomLoaded = done), 30000);
const roo = `${spec.room}.roo`;
if (rs(player!.roomRes).toLowerCase() !== roo) {
  log(`teleporting ${opt.user} to RID ${rid}`);
  const entered = waitFor(`the server to move us into ${roo}`, (done) => (roomLoaded = () => rs(player!.roomRes).toLowerCase() === roo && done()));
  await maint(`send object ${player!.id} TeleportTo RID int ${rid}`);
  await entered;
}
roomLoaded = undefined;

const results: { step: string; expected: string; got: string; ok: boolean }[] = [];
const check = (step: string, expected: string, got: string): void => {
  const ok = expected === got;
  results.push({ step, expected, got, ok });
  log(`${ok ? "ok  " : "FAIL"} ${step}: ${got}${ok ? "" : ` (expected ${expected})`}`);
};

// The server sends the checksum through a Kod integer: compare the low 28 bits.
const mask = 0x0fffffff;
check("room checksum matches the compiled file", "match", ((player!.roomSecurity ^ ours.security) & mask) === 0 ? "match" : `server ${player!.roomSecurity}, file ${ours.security}`);
mover.room = parseRoo(rooBytes);
mover.place(mover.x, mover.y, now); // again, now that it has the room: settles the height
log(`starting at ${where()}`);

for (const step of spec.steps) {
  const label = `${step.go ? "go" : `to ${step.to}`}${step.why ? ` (${step.why})` : ""}`;
  if (step.go) {
    const before = player!.roomId;
    const left = waitFor("a room change", (done) => (playerChanged = () => player!.roomId !== before && done()), 8000).then(
      () => `left for "${rs(player!.roomNameRes)}"`,
      () => "stayed",
    );
    conn.sendGame(P.buildSimple(P.BP.REQ_GO));
    const got = await left;
    check(label, "left", got.startsWith("left") ? "left" : got);
    log(`  ${got}`);
    continue;
  }
  const [r, c] = step.to!.split(",").map(Number);
  // The centre of Kod square (r, c) in client fine units.
  const tx = (c! - 0.5) * 1024;
  const ty = (r! - 0.5) * 1024;
  snapped = false;
  let best = Infinity;
  let bestAt = now;
  let reached = false;
  const FRAME = 16;
  for (const end = now + 30000; now < end && !snapped; now += FRAME) {
    const dx = tx - mover.x;
    const dy = ty - mover.y;
    const dist = Math.hypot(dx, dy);
    if (dist < 32) {
      reached = true;
      break;
    }
    if (dist < best - 4) {
      best = dist;
      bestAt = now;
    } else if (now - bestAt > 1500) break; // no headway: stopped by something
    // Face the target (angles: 4096 a circle, (cos, sin) along x, y) and hold forward.
    mover.angle = ((Math.round((Math.atan2(dy, dx) * 4096) / (2 * Math.PI)) % 4096) + 4096) % 4096;
    mover.update({ forward: 1, strafe: 0, run: false }, FRAME, now, [], player!.id);
    await sleep(4);
  }
  mover.flush(now);
  // A refusal of the last move arrives a moment later.
  await sleep(600);
  check(label, step.expect ?? "reached", snapped ? "blocked" : reached ? "reached" : "blocked");
  if (!reached || snapped) log(`  ${snapped ? "the server put us back at" : "stopped at"} ${where()}`);
}

finished = true;
conn.sendGame(P.buildSimple(P.BP.REQ_QUIT));
await sleep(300);
ws.close();
const failed = results.filter((x) => !x.ok);
console.log(`\n${results.length - failed.length}/${results.length} as expected${failed.length ? `; failed: ${failed.map((f) => f.step).join("; ")}` : ""}`);
process.exit(failed.length ? 1 : 0);
