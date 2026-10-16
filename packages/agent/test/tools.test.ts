// The agent's tools on a headless session: rebuilding the editor's test room
// through them, walking it, pictures, undo and batches, and shipped rooms.

/* eslint-disable @typescript-eslint/no-explicit-any -- tool results are JSON, checked here by shape */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { formatRoomSource } from "@meridian-editor/roomc";
import { HeadlessSession, type Session } from "../src/session.ts";
import { ImageOutput } from "../src/tool.ts";
import { TOOLS } from "../src/tools/index.ts";
import { createServer } from "../src/server.ts";

const REPO = join(import.meta.dirname, "../../..");
const ROOMS = join(REPO, "rooms");
const byName = new Map(TOOLS.map((t) => [t.name, t]));

/** Call a tool the way the MCP server does: arguments checked against its schema. */
async function call(s: Session, name: string, args: Record<string, unknown> = {}): Promise<any> {
  const t = byName.get(name);
  if (!t) throw new Error(`no tool ${name}`);
  return t.run(s, z.object(t.input).parse(args));
}

const scratch = mkdtempSync(join(tmpdir(), "meridian-agent-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** tools/shards/make-edtest.ts, done through the tools. */
async function buildEdtest(s: Session): Promise<void> {
  const H = 12 * 64;
  const squares = (r0: number, c0: number, r1: number, c1: number) => ({ from: [(c0 - 1) * 64, H - r1 * 64], to: [c1 * 64, H - (r0 - 1) * 64] });
  await call(s, "set_prefs", {
    prefs: { defaults: { floorHeight: 0, ceilingHeight: 160, floorTexture: 2011, ceilingTexture: 4607, light: 160, wallTexture: 4713, upperTexture: 4610, lowerTexture: 3102, passable: true } },
  });
  await call(s, "new_room", { name: "edtest", width: 16, height: 12, roomId: 4200, discard: true });

  const platform = await call(s, "draw_shape", { shape: "rectangle", ...squares(2, 3, 4, 5) });
  await call(s, "set_properties", { kind: "sector", indices: platform.newSectors, patch: { floorHeight: 16, floorTexture: 3101 } });

  const ledge = await call(s, "draw_shape", { shape: "rectangle", ...squares(2, 11, 5, 15) });
  await call(s, "set_properties", { kind: "sector", indices: ledge.newSectors, patch: { floorHeight: 64, floorTexture: 3101 } });

  const ramp = (await call(s, "draw_shape", { shape: "rectangle", ...squares(6, 11, 9, 15) })).newSectors[0];
  const { slope } = await call(s, "add_slope", { sector: ramp, which: "floor" });
  const south = H - 9 * 64;
  const points = slope.points.map(([x, y]: number[]) => [x, y, Math.round(((y! - south) / 256) * 64)]);
  await call(s, "set_slope", { sector: ramp, which: "floor", slope: { angle: slope.angle, points } });

  const tunnel = await call(s, "draw_shape", { shape: "rectangle", ...squares(8, 3, 10, 5) });
  await call(s, "set_properties", { kind: "sector", indices: tunnel.newSectors, patch: { ceilingHeight: 40, ceilingTexture: 4610 } });

  await call(s, "draw_shape", { shape: "rectangle", ...squares(6, 7, 7, 8), pillar: true });
}

describe("agent tools", () => {
  it("rebuild the editor's test room exactly as make-edtest.ts does", async () => {
    const s = new HeadlessSession(scratch, REPO);
    await buildEdtest(s);
    expect(formatRoomSource(s.room())).toBe(readFileSync(join(ROOMS, "new", "edtest.room.json"), "utf8"));
    const status = await call(s, "get_status");
    expect(status.compile.ok).toBe(true);
    const checks = await call(s, "run_checks", { which: ["sectors", "crossrefs"] });
    expect(checks.errors).toBe(0);
  });

  it("walk edtest the way its walk test expects", async () => {
    const s = new HeadlessSession(ROOMS, REPO);
    await call(s, "open_room", { path: "new/edtest.room.json" });
    const spec = JSON.parse(readFileSync(join(ROOMS, "new", "edtest.walk.json"), "utf8")) as { steps: { to?: string; expect?: "reached" | "blocked" }[] };
    const steps = spec.steps.filter((st) => st.to).map((st) => ({ to: st.to!, expect: st.expect }));
    // The Kod class sets the arrival at row 7, col 2.
    const out = await call(s, "walk", { from: "7,2", steps });
    expect(out.steps.filter((r: any) => r.expected)).toEqual([]);
    expect(out.failed).toBe(0);
    const ledge = out.steps.find((r: any) => r.to === "3,12");
    expect(ledge.outcome).toBe("blocked");
    expect(ledge.stoppedBy.reason).toMatch(/step up of 64/);
  });

  it("describe sectors and what's at a point", async () => {
    const s = new HeadlessSession(ROOMS, REPO);
    await call(s, "open_room", { path: "new/edtest.room.json" });
    const floor = await call(s, "at_point", { x: 64 * 1.5, y: 12 * 64 - 64 * 6.5 });
    expect(floor.kod).toMatchObject({ row: 7, col: 2 });
    const d = await call(s, "describe_sector", { index: floor.sector.index });
    // The main floor has holes: the platform, ledge, ramp, tunnel and pillar sit inside it.
    expect(d.loops.filter((l: any) => l.hole).length).toBeGreaterThan(0);
    const platform = d.neighbours.find((n: any) => n.floorStep === 16);
    expect(platform?.passableFromHere).toBe(true);
    const k = await call(s, "convert_coords", { from: "kod", row: 7, col: 2 });
    expect(k.editor).toEqual([96, 352]);
  });

  it("render the map as a PNG", async () => {
    const s = new HeadlessSession(ROOMS, REPO);
    await call(s, "open_room", { path: "new/edtest.room.json" });
    const out = await call(s, "render_map", { labels: ["sector", "linedef"], highlight: { kind: "sector", indices: [1] }, size: 512 });
    expect(out).toBeInstanceOf(ImageOutput);
    expect([...out.png.slice(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(out.info.size[0]).toBe(512);
  });

  it("undo, redo, stale revisions and batches", async () => {
    const s = new HeadlessSession(scratch, REPO);
    await call(s, "new_room", { name: "t", width: 8, height: 8 });
    const rev = s.revision();
    const r = await call(s, "draw_shape", { shape: "rectangle", from: [64, 64], to: [192, 192], ifRevision: rev });
    expect(r.newSectors).toHaveLength(1);
    await expect(call(s, "set_properties", { kind: "sector", indices: [1], patch: { floorHeight: 8 }, ifRevision: rev })).rejects.toThrow(/changed since revision/);
    expect((await call(s, "undo")).undid).toBe("draw rectangle");
    expect(s.room().sectors).toHaveLength(1);
    await call(s, "redo");
    expect(s.room().sectors).toHaveLength(2);

    const before = s.room();
    await expect(
      call(s, "batch", {
        steps: [
          { tool: "set_properties", args: { kind: "sector", indices: [1], patch: { floorHeight: 16 } } },
          { tool: "make_door", args: { sector: 99 } },
        ],
      }),
    ).rejects.toThrow(/no sector 99/);
    expect(s.room()).toBe(before);

    const depth = s.undoDepth();
    const b = await call(s, "batch", {
      label: "raise and light",
      steps: [
        { tool: "set_properties", args: { kind: "sector", indices: [1], patch: { floorHeight: 16 } } },
        { tool: "set_flags", args: { kind: "sector", indices: [1], fields: { depth: 1 }, on: ["flicker"] } },
      ],
    });
    expect(b.compile.ok).toBe(true);
    expect(s.undoDepth()).toBe(depth + 1);
    expect(s.room().sectors[1]).toMatchObject({ floorHeight: 16, flags: 0x201 });
    await call(s, "undo");
    expect(s.room().sectors[1]!.floorHeight).toBe(0);
  });

  it("refuse to delete the room-box corners or throw away unsaved work", async () => {
    const s = new HeadlessSession(scratch, REPO);
    await call(s, "new_room", { name: "t", width: 8, height: 8 });
    await expect(call(s, "delete_items", { kind: "thing", indices: [0] })).rejects.toThrow(/room-box corners/);
    await expect(call(s, "new_room", { name: "u", width: 8, height: 8 })).rejects.toThrow(/unsaved/);
    const saved = await call(s, "save_room", { path: "t.room.json" });
    expect(saved.saved).toBe("t.room.json");
    await expect(call(s, "save_room", { path: "../escape.room.json" })).rejects.toThrow(/escapes/);
    await call(s, "new_room", { name: "u", width: 8, height: 8 });
  });

  it("guard the Shards tools", async () => {
    const s = new HeadlessSession(scratch, REPO);
    await call(s, "new_room", { name: "unsaved", width: 4, height: 4, discard: true });
    await expect(call(s, "shards_install", { confirmed: true })).rejects.toThrow(/save the room there first/);
    expect(() => z.object(byName.get("shards_install")!.input).parse({})).toThrow();
  });

  it.skipIf(!existsSync(join(ROOMS, "src", "raza.room.json")))("read a shipped room", async () => {
    const s = new HeadlessSession(ROOMS, REPO);
    await call(s, "open_room", { path: "src/raza.room.json" });
    const sum = await call(s, "room_summary");
    expect(sum.statistics.Sectors).toBeGreaterThan(10);
    const c = await call(s, "compile", { target: "104" });
    expect(c.ok).toBe(true);
    const found = await call(s, "find_items", { kind: "linedef", where: { oneSided: true } });
    expect(found.count).toBeGreaterThan(0);
    const img = await call(s, "render_map", {});
    expect(img).toBeInstanceOf(ImageOutput);
  });

  it("register every tool with the MCP server", () => {
    const server = createServer(new HeadlessSession(scratch, REPO));
    expect(server).toBeTruthy();
    expect(new Set(TOOLS.map((t) => t.name)).size).toBe(TOOLS.length);
  });
});
