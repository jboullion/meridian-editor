#!/usr/bin/env node
// The Meridian room editor's MCP server: the editor's own operations for AI
// agents, over stdio.
//
//   node packages/agent/src/server.ts [--rooms <dir>]
//
// It starts headless, on room files: one room open at a time, with undo, in
// this process. Rooms default to rooms/ in this repo (or EDITOR_ROOMS_DIR).
// connect_editor switches to the room open in a running editor (live.ts).

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { HeadlessSession } from "./session.ts";
import { PROMPTS } from "./prompts.ts";
import { currentKodSource, currentRoomSource, documents } from "./resources.ts";
import { ImageOutput } from "./tool.ts";
import { connectionTools, type SessionHolder } from "./tools/connect.ts";
import { TOOLS } from "./tools/index.ts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

export function createServer(headless: HeadlessSession): McpServer {
  const holder: SessionHolder = { session: headless, headless };
  const server = new McpServer(
    { name: "meridian-room-editor", version: "0.1.0" },
    {
      instructions:
        "Tools for building and editing Meridian 59 rooms with the room editor's own operations. Read the meridian://primer resource first. Start with get_status; coordinates are editor units (64 a square, y north); look with render_map; finish with run_checks, compile and walk. To work in the editor the user has open (they watch each change, and get the 3D view), call connect_editor.",
    },
  );

  // One call at a time: edits and batches must not interleave.
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T,>(fn: () => Promise<T>): Promise<T> => {
    const next = queue.then(fn, fn);
    queue = next.catch(() => undefined);
    return next;
  };

  for (const t of [...TOOLS, ...connectionTools(holder)]) {
    server.registerTool(t.name, { title: t.title, description: t.description, inputSchema: t.input, annotations: { title: t.title, ...t.annotations } }, (args: Record<string, unknown>) =>
      serial(async () => {
        try {
          const session = holder.session;
          if (!t.raw) await session.sync?.();
          const out = await t.run(session, args);
          if (!t.raw) await session.flush?.();
          if (out instanceof ImageOutput) {
            return {
              content: [
                { type: "image" as const, data: Buffer.from(out.png).toString("base64"), mimeType: "image/png" },
                { type: "text" as const, text: JSON.stringify(out.info, null, 1) },
              ],
            };
          }
          return { content: [{ type: "text" as const, text: JSON.stringify(out, null, 1) }] };
        } catch (e) {
          return { isError: true, content: [{ type: "text" as const, text: (e as Error).message }] };
        }
      }),
    );
  }

  for (const d of documents(headless)) {
    server.registerResource(d.name, d.uri, { title: d.title, description: d.description, mimeType: "text/markdown" }, async (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/markdown", text: await d.read() }] }));
  }
  server.registerResource("room", "meridian://room/current", { title: "The open room's source", description: "The open room as .room.json text.", mimeType: "application/json" }, async (uri) => ({
    contents: [{ uri: uri.href, mimeType: "application/json", text: await currentRoomSource(holder.session) }],
  }));
  server.registerResource("kod", "meridian://kod/current", { title: "The open room's Kod class", description: "The Kod source of the room class that uses this room.", mimeType: "text/plain" }, async (uri) => ({
    contents: [{ uri: uri.href, mimeType: "text/plain", text: await currentKodSource(holder.session) }],
  }));
  for (const p of PROMPTS) {
    server.registerPrompt(p.name, { title: p.title, description: p.description, argsSchema: p.args }, (args: Record<string, unknown>) => ({
      messages: [{ role: "user" as const, content: { type: "text" as const, text: p.text(args as Record<string, string | undefined>) } }],
    }));
  }
  return server;
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { rooms: { type: "string" } } });
  const roomsDir = resolve(values.rooms ?? process.env.EDITOR_ROOMS_DIR ?? join(REPO, "rooms"));
  const server = createServer(new HeadlessSession(roomsDir, REPO));
  await server.connect(new StdioServerTransport());
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
