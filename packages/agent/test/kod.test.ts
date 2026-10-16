// Kod for new rooms (rooms/new/<room>.kod) written through the tools, and the
// texture tools. The Kod and texture parts need the Shards checkout and the
// installed client, so they're skipped without them.

/* eslint-disable @typescript-eslint/no-explicit-any -- tool results are JSON, checked here by shape */

import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { defaultKodDir } from "../../../apps/editor/src/main/kod.ts";
import { defaultTexturesDir } from "../../../apps/editor/src/main/textures.ts";
import { addToMessage, setVariable } from "../src/kodWrite.ts";
import { HeadlessSession, type Session } from "../src/session.ts";
import { ImageOutput } from "../src/tool.ts";
import { TOOLS } from "../src/tools/index.ts";

const REPO = join(import.meta.dirname, "../../..");
const byName = new Map(TOOLS.map((t) => [t.name, t]));
async function call(s: Session, name: string, args: Record<string, unknown> = {}): Promise<any> {
  const t = byName.get(name)!;
  return t.run(s, z.object(t.input).parse(args));
}

const scratch = mkdtempSync(join(tmpdir(), "meridian-kod-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe("Kod text edits", () => {
  const edtest = readFileSync(join(REPO, "rooms", "new", "edtest.kod"), "utf8");

  it("add lines to an existing message, before propagate", () => {
    const out = addToMessage(edtest, "CreateStandardExits", ["plExits = Cons([ 2, 2, RID_TOS, 1, 1, ROTATE_NONE ],plExits);"]);
    const body = out.slice(out.indexOf("CreateStandardExits()"), out.indexOf("end\n"));
    expect(body.indexOf("RID_TOS, 1, 1")).toBeLessThan(body.indexOf("propagate;"));
    expect(body.indexOf("RID_TOS, 45, 31")).toBeLessThan(body.indexOf("RID_TOS, 1, 1"));
  });

  it("create a message that isn't there", () => {
    const out = addToMessage(edtest, "CreateStandardObjects", ["Send(self,@NewHold,#what=Create(&Brazier),#new_row=2,#new_col=2);"]);
    expect(out).toMatch(/CreateStandardObjects\(\)\n {3}\{\n {6}Send\(self,@NewHold,#what=Create\(&Brazier\),#new_row=2,#new_col=2\);\n {6}propagate;\n {3}\}\n\nend/);
  });

  it("set and add variables", () => {
    const replaced = setVariable(edtest, "properties", "piBaseLight", "LIGHT_MAX");
    expect(replaced).toContain("   piBaseLight = LIGHT_MAX\n");
    expect(replaced).not.toContain("LIGHT_NICE");
    const added = setVariable(edtest, "classvars", "viIndoors", "TRUE");
    const classvars = added.slice(added.indexOf("classvars:"), added.indexOf("properties:"));
    expect(classvars).toContain("   viIndoors = TRUE\n");
  });
});

describe.skipIf(!defaultKodDir(REPO))("Kod tools", () => {
  it("write a new room's class and read it back", async () => {
    mkdirSync(join(scratch, "new"));
    copyFileSync(join(REPO, "rooms", "new", "edtest.room.json"), join(scratch, "new", "kodtest.room.json"));
    const s = new HeadlessSession(scratch, REPO);
    await call(s, "open_room", { path: "new/kodtest.room.json" });
    await call(s, "set_properties", { kind: "room", patch: { roomId: 4201 } });
    const made = await call(s, "kod_new_room", { className: "KodTestRoom", title: "Kod test", arrival: "7,2", noCombat: true });
    expect(made.reads).toMatchObject({ className: "KodTestRoom", arrival: "7,2" });
    await call(s, "kod_add_exit", { at: "11,8", to: "RID_TOS", toSquare: "45,31", comment: "to Tos" });
    await call(s, "kod_add_object", { className: "Brazier", at: "3,3", fineRow: 16 });
    await call(s, "kod_set", { section: "properties", name: "piOutside_factor", value: "3" });

    const k = await call(s, "kod_room");
    expect(k.className).toBe("KodTestRoom");
    expect(k.file).toMatch(/kodtest\.kod/);
    expect(k.exits).toMatchObject([{ square: "11,8", to: "RID_TOS", toSquare: "45,31" }]);
    expect(k.objects).toMatchObject([{ what: "Brazier", square: "3,3", fine: [16, 32] }]);
    expect(k.light.outsideFactor).toBe(3);

    const checks = await call(s, "run_checks", { which: ["kod"] });
    expect(checks.errors).toBe(0);
    const lights = await call(s, "kod_lights", { hour: 22 });
    expect(lights.lights.map((l: any) => l.what)).toContain("Brazier");
    await expect(call(s, "kod_new_room", { className: "KodTestRoom", title: "x", arrival: "1,1" })).rejects.toThrow(/exists/);
  });
});

describe.skipIf(!defaultTexturesDir(REPO))("texture tools", () => {
  it("list, look at and find textures", async () => {
    const s = new HeadlessSession(join(REPO, "rooms"), REPO);
    await call(s, "open_room", { path: "new/edtest.room.json" });
    const used = await call(s, "textures_in_use");
    const numbers = used.textures.map((t: any) => t.texture);
    expect(numbers).toContain(4713);
    const list = await call(s, "list_textures", { numbers: [4713] });
    expect(list.total).toBeGreaterThan(100);
    expect(list.sizes[0]).toMatchObject({ number: 4713 });
    expect(list.sizes[0].editorWidth).toBeGreaterThan(0);
    const sheet = await call(s, "view_textures", { numbers, tile: 64 });
    expect(sheet).toBeInstanceOf(ImageOutput);
    expect(sheet.info.textures).toHaveLength(numbers.length);
  });
});
