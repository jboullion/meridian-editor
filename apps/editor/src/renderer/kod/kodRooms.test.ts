import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { shardsPaths } from "../../main/shardsPaths.ts";
import { buildKodIndex, kodCandidates, kodToEditor, parseKodRoom } from "./kodRooms.ts";

const SAMPLE = `
// A test room
TestHut is Room

constants:
   include blakston.khd

resources:
   room_name_TestHut = "The Test Hut"
   room_TestHut = testhut.roo   // the geometry

classvars:
   viTeleport_row = 4
   viTeleport_col = 5

properties:
   prRoom = room_TestHut
   piRoom_num = RID_TEST_HUT

messages:
   Constructed()
   {
      plLooping_sounds = [[ fire_sound, 4, 7, 10, 100 ]];
      plGenerators = [ [3, 4],
                       [5, 6] ];
      propagate;
   }

   CreateStandardExits()
   {
      plExits = $;
      plExits = Cons([ 2, 5, ROOM_LOCKED_DOOR, TestHut_locked ],plExits);
      // plExits = Cons([ 9, 9, RID_OLD, 1, 1, ROTATE_NONE ],plExits);
      plExits = Cons([ 7, 4, RID_KA3, 29, 12, ROTATE_NONE ],plExits);
      plEdge_Exits = Cons([ LEAVE_NORTH, RID_KA3, 43, 41, ROTATE_NONE ],plEdge_Exits);
      propagate;
   }

   CreateStandardObjects()
   {
      local lObjCoords1;
      lObjCoords1 = [ [06,02,32,56,OO_quiver], [3,7,OO_ironpot] ];
      Send(self,@CreateOrnObjFromList,#lObjlist=lObjCoords1);
      send(self,@NewHold,#what=Create(&Candle),#new_row=2,#new_col=4,
           #fine_row=56,#fine_col=40);
      Send(self,@NewHold,#what=Create(&DynamicLight,#iColor=LIGHT_FIRE,#iIntensity=30),
           #new_row=4,#new_col=7);
      Send(self,@NewHold,#what=oThing,#new_row=iRow,#new_col=iCol);
      propagate;
   }
end
`;

describe("Kod room classes", () => {
  const rids = new Map([
    ["RID_TEST_HUT", 77],
    ["RID_KA3", 300],
  ]);

  it("reads where a class puts things", () => {
    const k = parseKodRoom({ path: "room/testhut.kod", text: SAMPLE }, rids)!;
    expect(k).toMatchObject({ className: "TestHut", roo: "testhut.roo", ridName: "RID_TEST_HUT", rid: 77 });
    expect(k.teleport).toMatchObject({ row: 4, col: 5 });
    expect(k.exits.map((e) => [e.row, e.col, e.dest, e.destRow, e.destCol])).toEqual([
      [2, 5, null, undefined, undefined],
      [7, 4, "RID_KA3", 29, 12],
    ]);
    // Line numbers point at the exit in the file (the commented-out one is skipped).
    expect(SAMPLE.split("\n")[k.exits[1]!.line - 1]).toContain("RID_KA3, 29, 12");
    expect(k.edgeExits).toEqual([{ side: "north", dest: "RID_KA3", destRow: 43, destCol: 41, line: expect.any(Number) }]);
    expect(k.generators.map((g) => [g.row, g.col])).toEqual([
      [3, 4],
      [5, 6],
    ]);
    expect(SAMPLE.split("\n")[k.generators[1]!.line - 1]).toContain("[5, 6]");
    expect(k.objects.map((o) => [o.what, o.row, o.col, o.fineRow, o.fineCol])).toEqual([
      ["Candle", 2, 4, 56, 40],
      ["DynamicLight", 4, 7, 32, 32],
      ["OO_quiver", 6, 2, 32, 56],
      ["OO_ironpot", 3, 7, 32, 32],
    ]);
    expect(k.sounds.map((s) => [s.what, s.row, s.col])).toEqual([["fire_sound", 4, 7]]);
  });

  it("places Kod squares from the room box's top-left corner", () => {
    const box = { left: 0, top: 768 };
    expect(kodToEditor(box, { row: 1, col: 1, fineRow: 0, fineCol: 0 })).toEqual([0, 768]);
    expect(kodToEditor(box, { row: 11, col: 8, fineRow: 32, fineCol: 32 })).toEqual([7 * 64 + 32, 768 - (10 * 64 + 32)]);
  });
});

const SHARDS = shardsPaths(join(import.meta.dirname, "../../../../.."));
const KOD = process.env.KOD_DIR ?? SHARDS?.kod ?? "";
const ROOMS = SHARDS?.roo ?? "";

describe.skipIf(!existsSync(join(KOD, "include", "blakston.khd")))("the server's Kod", () => {
  const files: { path: string; text: string }[] = [];
  const walk = (d: string): void => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (n.endsWith(".kod")) files.push({ path: relative(KOD, p).split(sep).join("/"), text: readFileSync(p, "latin1") });
    }
  };
  walk(join(KOD, "object", "active", "holder", "room"));
  const index = buildKodIndex(KOD, files, readFileSync(join(KOD, "include", "blakston.khd"), "latin1"));

  it("finds a class for nearly every shipped room", () => {
    const rooms = existsSync(ROOMS) ? readdirSync(ROOMS).filter((f) => f.endsWith(".roo")) : [];
    const missing = rooms.filter((r) => kodCandidates(index, r, 0).length === 0);
    expect(missing.length).toBeLessThan(10);
  });

  it("prefers the class named after the room when several share its .roo", () => {
    expect(kodCandidates(index, "tos.room.json", 0)[0]?.className).toBe("Tos");
    expect(kodCandidates(index, "bowmaker.room.json", 0)[0]).toMatchObject({ className: "BowmakerHut", teleport: { row: 4, col: 4 } });
  });
});
