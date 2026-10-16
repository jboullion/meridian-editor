// The MCP server over stdio, as Claude Code runs it from .mcp.json.

import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { TOOLS } from "../src/tools/index.ts";

const REPO = join(import.meta.dirname, "../../..");
const client = new Client({ name: "test", version: "0" });

beforeAll(async () => {
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(REPO, "packages/agent/src/server.ts")], cwd: REPO, stderr: "pipe" }));
});
afterAll(() => client.close());

const text = (r: unknown): string => ((r as { content: { type: string; text?: string }[] }).content.find((c) => c.type === "text")?.text ?? "");

describe("the MCP server", () => {
  it("lists every tool with its schema", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...TOOLS.map((t) => t.name), "connect_editor", "disconnect_editor"].sort());
    const draw = tools.find((t) => t.name === "draw_shape")!;
    expect(draw.inputSchema.properties).toHaveProperty("shape");
  });

  it("opens a room, edits it, and returns a picture", async () => {
    const open = await client.callTool({ name: "open_room", arguments: { path: "new/edtest.room.json" } });
    expect(JSON.parse(text(open))).toMatchObject({ room: "edtest", dirty: false });
    const edit = await client.callTool({ name: "set_properties", arguments: { kind: "sector", indices: [1], patch: { light: 200 } } });
    expect(JSON.parse(text(edit))).toMatchObject({ changed: true, compile: { ok: true } });
    const img = await client.callTool({ name: "render_map", arguments: { size: 256 } });
    expect((img.content as { type: string; mimeType?: string }[])[0]).toMatchObject({ type: "image", mimeType: "image/png" });
  });

  it("reports tool errors without failing the call", async () => {
    const r = await client.callTool({ name: "make_door", arguments: { sector: 999 } });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/no sector 999/);
  });

  it("offers prompts", async () => {
    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name)).toEqual(["build-room", "review-room", "port-room"]);
    const p = await client.getPrompt({ name: "build-room", arguments: { name: "cellar", description: "a damp cellar" } });
    expect((p.messages[0]!.content as { text: string }).text).toMatch(/new_room \(name cellar/);
  });

  it("serves the primer and the manual", async () => {
    const { resources } = await client.listResources();
    expect(resources.map((r) => r.uri)).toContain("meridian://primer");
    const primer = await client.readResource({ uri: "meridian://primer" });
    expect((primer.contents[0] as { text: string }).text).toMatch(/64 per grid square/);
  });
});
