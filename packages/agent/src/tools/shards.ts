// Testing a new room on the local Shards server, through tools/shards: install
// it (the .roo, its Kod, the room object) and walk it with a real client
// login. Installing changes the running server, so it takes the user's say-so
// every time; walking logs in only as shardpal, and not while anyone is on it.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { BROWSER, findRoom, maint } from "../../../../tools/shards/shards.ts";
import { OpError, type Session } from "../session.ts";
import { tool } from "../tool.ts";

const TEST_ACCOUNT = "shardpal";

function run(repo: string, script: string, args: string[], timeoutMs: number): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(repo, "tools", "shards", script), ...args], { cwd: repo, env: process.env });
    let output = "";
    child.stdout.on("data", (d: Buffer) => (output += d.toString()));
    child.stderr.on("data", (d: Buffer) => (output += d.toString()));
    const timer = setTimeout(() => {
      output += `\n(stopped after ${timeoutMs / 1000}s)`;
      child.kill();
    }, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, output });
    });
  });
}

/** The last lines, which say how it went. */
const tail = (text: string, lines = 60): string[] => text.trim().split(/\r?\n/).slice(-lines);

function newRoomName(s: Session, room: string | undefined): string {
  const name = room ?? s.doc()?.name;
  if (!name || !/^\w+$/.test(name)) throw new OpError("Give the room's name: a room in rooms/new.");
  if (!existsSync(join(s.roomsDir, "new", `${name}.room.json`))) throw new OpError(`rooms/new/${name}.room.json doesn't exist: save the room there first (save_room with path new/${name}.room.json).`);
  if (s.hasRoom() && s.doc()?.name === name && s.dirty()) throw new OpError(`${name} has unsaved changes: save_room first, since the install reads the file.`);
  return name;
}

/** Who's online, from the maintenance port's `who`; throws if the server isn't up. */
async function who(): Promise<string> {
  const [out] = await maint("who");
  return (out ?? "").trim();
}

export const shardsTools = [
  tool({
    name: "shards_status",
    title: "The local Shards server",
    description: "Whether the local Shards server (blakserv) is running, who is logged in, and whether the open room's RID is loaded there.",
    input: {},
    annotations: { readOnlyHint: true, openWorldHint: true },
    run: async (s) => {
      if (!existsSync(BROWSER)) throw new OpError(`No Shards checkout at ${BROWSER} (set MERIDIAN_BROWSER).`);
      let online: string;
      try {
        online = await who();
      } catch (e) {
        return { running: false, error: (e as Error).message };
      }
      const rid = s.hasRoom() ? s.room().roomId : 0;
      const object = rid ? await findRoom(rid) : null;
      return { running: true, who: online, ...(rid ? { roomId: rid, loaded: object !== null, ...(object !== null ? { object } : {}) } : {}) };
    },
  }),

  tool({
    name: "shards_install",
    title: "Install the room on the local Shards server",
    description:
      "Put a room from rooms/new on the local Shards server (tools/shards/install.ts): compile it for 104, copy the .roo to the server and the clients' assets, and if its Kod changed, build the Kod, run `reload system` (which SAVES THE GAME) and rebuild the assets; then create or recreate the room object (players in it go along). It changes the running server, so ask the user each time and pass confirmed only once they agree. Takes a few minutes when the Kod changed.",
    input: {
      room: z.string().optional().describe("Default: the open room"),
      confirmed: z.literal(true).describe("The user agreed to this install"),
    },
    annotations: { destructiveHint: true, openWorldHint: true },
    run: async (s, { room }) => {
      const name = newRoomName(s, room);
      if (!existsSync(join(s.roomsDir, "new", `${name}.kod`))) throw new OpError(`rooms/new/${name}.kod doesn't exist: write the room's Kod first (kod_new_room).`);
      const r = await run(s.repoRoot, "install.ts", [name], 15 * 60_000);
      if (r.code !== 0) throw new OpError(`The install failed (exit ${r.code}):\n${tail(r.output).join("\n")}`);
      return { installed: name, log: tail(r.output, 30), next: "shards_walk tests it with the game's movement; an admin can visit with: send object <player> TeleportTo RID int <roomId>" };
    },
  }),

  tool({
    name: "shards_walk",
    title: "Walk the room on the local Shards server",
    description: `Walk a room on the local server as a player (tools/shards/walk.ts), following rooms/new/<room>.walk.json (write one with walk's saveAs). It logs in as ${TEST_ACCOUNT}, never anyone else, and refuses if ${TEST_ACCOUNT} is already online. Each step reports whether it went as expected.`,
    input: { room: z.string().optional().describe("Default: the open room") },
    annotations: { openWorldHint: true },
    run: async (s, { room }) => {
      const name = newRoomName(s, room);
      if (!existsSync(join(s.roomsDir, "new", `${name}.walk.json`))) throw new OpError(`rooms/new/${name}.walk.json doesn't exist: run walk with saveAs: "${name}" first.`);
      let online: string;
      try {
        online = await who();
      } catch (e) {
        throw new OpError(`The local server isn't answering: ${(e as Error).message}`);
      }
      if (new RegExp(`\\b${TEST_ACCOUNT}\\b`, "i").test(online)) throw new OpError(`${TEST_ACCOUNT} is logged in right now; logging in would take over that session. Who's on:\n${online}`);
      const r = await run(s.repoRoot, "walk.ts", [name, "--user", TEST_ACCOUNT], 5 * 60_000);
      const summary = /(\d+)\/(\d+) as expected/.exec(r.output);
      return {
        room: name,
        ok: r.code === 0,
        ...(summary ? { asExpected: Number(summary[1]), steps: Number(summary[2]) } : {}),
        log: tail(r.output, 50),
      };
    },
  }),
];
