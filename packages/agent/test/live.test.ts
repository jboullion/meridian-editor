// LiveSession against a stand-in for the editor page (agent.ts): each tool call
// reads the state, works on it, and sends back one labelled step; edits made
// in the editor meanwhile are refused, not overwritten.

/* eslint-disable @typescript-eslint/no-explicit-any -- tool results are JSON, checked here by shape */

import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { RoomSource } from "@meridian-editor/roomc";
import type { AgentCall, AgentState } from "../../../apps/editor/src/main/agentProtocol.ts";
import { newRoomWithFloor } from "../../../apps/editor/src/renderer/ops/edit.ts";
import { LiveSession } from "../src/live.ts";
import { DEFAULT_PREFS, HeadlessSession, type EditorLink, type Session } from "../src/session.ts";
import { TOOLS } from "../src/tools/index.ts";

const REPO = join(import.meta.dirname, "../../..");
const byName = new Map(TOOLS.map((t) => [t.name, t]));

/** What the page does with each call, minus the UI. */
class FakeEditor implements EditorLink {
  readonly kind = "web" as const;
  room: RoomSource | null = newRoomWithFloor(8, 8, DEFAULT_PREFS.defaults);
  saved: RoomSource | null = this.room;
  undo: RoomSource[] = [];
  revision = 0;
  name = "fake";
  calls: AgentCall[] = [];

  /** The user edits the room in the editor. */
  userEdit(): void {
    this.undo.push(this.room!);
    this.room = { ...this.room!, roomId: this.room!.roomId + 1 };
    this.revision++;
  }

  async call<T>(c: AgentCall): Promise<T> {
    this.calls.push(c);
    switch (c.op) {
      case "state":
        return {
          roomsDir: join(REPO, "rooms"),
          path: null,
          name: this.name,
          room: this.room,
          dirty: this.room !== this.saved,
          revision: this.revision,
          undoDepth: this.undo.length,
          redoDepth: 0,
          target: "104",
          prefs: DEFAULT_PREFS,
          selection: null,
          view: "split",
          mode: "sector",
          light: { mode: "game", hour: 12, playerLight: 5, fog: true, sources: true },
          display: { grid: 16, snap: true, showGrid: true, colorBy: "floor", ceilings: false, kod: true },
          walk: { active: false, at: null, floor: 0, angle: 0 },
          kodClass: null,
        } satisfies AgentState as T;
      case "replace":
        if (c.ifRevision !== this.revision) throw new Error(`The room changed in the editor while the agent worked on it (revision ${this.revision}, not ${c.ifRevision}).`);
        this.undo.push(this.room!);
        this.room = c.room;
        this.revision++;
        return { revision: this.revision } as T;
      case "load":
        this.room = c.room;
        this.saved = c.saved ? c.room : null;
        this.name = c.name;
        this.undo = [];
        this.revision++;
        return { revision: this.revision } as T;
      case "undo": {
        const prev = this.undo.pop();
        if (prev) {
          this.room = prev;
          this.revision++;
        }
        return { changed: !!prev } as T;
      }
      default:
        return null as T;
    }
  }
}

/** A tool call as the server makes it: sync, run, flush. */
async function call(s: Session, name: string, args: Record<string, unknown> = {}): Promise<any> {
  const t = byName.get(name)!;
  await s.sync?.();
  const out = await t.run(s, z.object(t.input).parse(args));
  await s.flush?.();
  return out;
}

describe("live sessions", () => {
  it("send each tool call back as one labelled step, with the revision the editor ends at", async () => {
    const editor = new FakeEditor();
    const s = new LiveSession(editor, REPO);
    const r = await call(s, "draw_shape", { shape: "rectangle", from: [64, 64], to: [192, 192] });
    expect(r.newSectors).toEqual([1]);
    expect(r.revision).toBe(editor.revision);
    const replace = editor.calls.find((c) => c.op === "replace");
    expect(replace).toMatchObject({ label: "draw rectangle" });

    const b = await call(s, "batch", {
      label: "raise",
      steps: [
        { tool: "set_properties", args: { kind: "sector", indices: [1], patch: { floorHeight: 16 } } },
        { tool: "set_properties", args: { kind: "sector", indices: [1], patch: { light: 200 } } },
      ],
    });
    expect(b.revision).toBe(editor.revision);
    expect(editor.calls.filter((c) => c.op === "replace")).toHaveLength(2);
    expect(editor.room!.sectors[1]).toMatchObject({ floorHeight: 16, light: 200 });

    // ifRevision works against the editor's own revision.
    await call(s, "set_properties", { kind: "sector", indices: [1], patch: { light: 100 }, ifRevision: editor.revision });
    expect(editor.room!.sectors[1]!.light).toBe(100);
  });

  it("refuse to overwrite an edit made in the editor meanwhile", async () => {
    const editor = new FakeEditor();
    const s = new LiveSession(editor, REPO);
    await s.sync();
    const t = byName.get("set_properties")!;
    await t.run(s, z.object(t.input).parse({ kind: "sector", indices: [0], patch: { floorHeight: 8 } }));
    editor.userEdit();
    await expect(s.flush()).rejects.toThrow(/changed in the editor/);
    expect(editor.room!.sectors[0]!.floorHeight).toBe(0);
  });

  it("open, undo in the editor, and say when there is no editor", async () => {
    const editor = new FakeEditor();
    const s = new LiveSession(editor, REPO);
    const opened = await call(s, "open_room", { path: "new/edtest.room.json", discard: true });
    expect(opened).toMatchObject({ room: "edtest", dirty: false });
    expect(editor.calls.find((c) => c.op === "load")).toMatchObject({ name: "edtest", saved: true });
    await call(s, "set_properties", { kind: "room", patch: { roomId: 1 } });
    const u = await call(s, "undo");
    expect(u.undid).not.toBeNull();
    expect(editor.room!.roomId).toBe(4200);

    await expect(call(new HeadlessSession(join(REPO, "rooms"), REPO), "render_3d")).rejects.toThrow(/connect_editor/);
  });
});
