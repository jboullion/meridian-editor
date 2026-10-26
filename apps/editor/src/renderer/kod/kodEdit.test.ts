import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { shardsPaths } from "../../main/shardsPaths.ts";
import { OpError } from "../ops/types.ts";
import { addExit, removeExit, setExit, type ExitSpec } from "./kodEdit.ts";
import { exitStatements, parseKodRoom, parseRids, stripComments, type KodExit } from "./kodRooms.ts";

const SAMPLE = `TestHut is Room

resources:
   room_TestHut = testhut.roo
   testhut_gate = "The gate is shut."

properties:
   prRoom = room_TestHut
   piRoom_num = 77

messages:
   CreateStandardExits()
   {
      plExits = $;

      plExits = Cons([ 2, 5, ROOM_LOCKED_DOOR, testhut_gate ],plExits);
      // plExits = Cons([ 9, 9, RID_OLD, 1, 1, ROTATE_NONE ],plExits);
      plExits = Cons([ 7, 4, RID_KA3, 29, 12, ROTATE_NONE ],plExits);   // to the forest

      plEdge_Exits = $;
      propagate;
   }
end
`;

const rids = new Map([["RID_KA3", 300]]);
const exits = (text: string): KodExit[] => parseKodRoom({ path: "testhut.kod", text }, rids)!.exits;
const brief = (e: KodExit) => [e.row, e.col, e.dest, e.destRow, e.destCol, e.rotate, e.message];

describe("editing a class's exits", () => {
  it("reads a locked door's message and an exit's rotation", () => {
    expect(exits(SAMPLE).map(brief)).toEqual([
      [2, 5, null, undefined, undefined, undefined, "testhut_gate"],
      [7, 4, "RID_KA3", 29, 12, "ROTATE_NONE", undefined],
    ]);
  });

  it("changes one exit's fields and nothing else", () => {
    const out = setExit(SAMPLE, 0, { row: 2, col: 6, dest: "RID_KA3", destRow: 3, destCol: 4 });
    expect(out.split("\n").filter((l, i) => l !== SAMPLE.split("\n")[i])).toEqual(["      plExits = Cons([ 2, 6, RID_KA3, 3, 4, ROTATE_NONE ],plExits);"]);
    expect(exits(out).map(brief)[0]).toEqual([2, 6, "RID_KA3", 3, 4, "ROTATE_NONE", undefined]);
    // The comment after the second exit stays.
    expect(setExit(SAMPLE, 1, { row: 7, col: 4, dest: null })).toContain("ROOM_LOCKED_DOOR ],plExits);   // to the forest");
  });

  it("removes an exit with its line, skipping commented-out ones", () => {
    const out = removeExit(SAMPLE, 1);
    expect(exits(out).map((e) => [e.row, e.col])).toEqual([[2, 5]]);
    expect(out).not.toContain("to the forest");
    expect(out).toContain("// plExits = Cons([ 9, 9");
    expect(out.split("\n").length).toBe(SAMPLE.split("\n").length - 1);
  });

  it("adds an exit after the last one, indented the same", () => {
    const out = addExit(SAMPLE, { row: 3, col: 3, dest: null });
    const lines = out.split("\n");
    expect(lines[lines.findIndex((l) => l.includes("to the forest")) + 1]).toBe("      plExits = Cons([ 3, 3, ROOM_LOCKED_DOOR ],plExits);");
    expect(exits(out)).toHaveLength(3);
  });

  it("adds CreateStandardExits to a class without one", () => {
    const bare = "Hut is Room\r\n\r\nresources:\r\n   room_Hut = hut.roo\r\n\r\nproperties:\r\n   prRoom = room_Hut\r\n\r\nend\r\n";
    const out = addExit(bare, { row: 1, col: 2, dest: "RID_KA3", destRow: 5, destCol: 6, rotate: "ROTATE_180" });
    expect(out).toContain("   CreateStandardExits()\r\n   {\r\n      plExits = $;\r\n\r\n      plExits = Cons([ 1, 2, RID_KA3, 5, 6, ROTATE_180 ],plExits);\r\n      propagate;\r\n   }");
    expect(out.replace(/\r\n/g, "")).not.toContain("\n");
  });

  it("keeps the file's CRLF line endings", () => {
    const crlf = SAMPLE.replace(/\n/g, "\r\n");
    for (const out of [addExit(crlf, { row: 3, col: 3, dest: null }), removeExit(crlf, 0), setExit(crlf, 1, { row: 8, col: 4, dest: null, message: "testhut_gate" })]) {
      expect(out.replace(/\r\n/g, "")).not.toContain("\n");
      expect(exits(out).length).toBeGreaterThan(0);
    }
  });

  it("refuses a second exit on one square, and bad fields", () => {
    expect(() => addExit(SAMPLE, { row: 7, col: 4, dest: null })).toThrow(/already has an exit \(line 18\)/);
    expect(() => setExit(SAMPLE, 0, { row: 7, col: 4, dest: null })).toThrow(OpError);
    expect(setExit(SAMPLE, 1, { row: 7, col: 4, dest: null })).toContain("[ 7, 4, ROOM_LOCKED_DOOR ]");
    const bad: ExitSpec[] = [
      { row: 0, col: 1, dest: null },
      { row: 1, col: 1, dest: "the inn", destRow: 1, destCol: 1 },
      { row: 1, col: 1, dest: "RID_KA3", destRow: 0, destCol: 1 },
      { row: 1, col: 1, dest: null, message: "two words" },
    ];
    for (const e of bad) expect(() => addExit(SAMPLE, e)).toThrow(OpError);
    expect(() => removeExit(SAMPLE, 5)).toThrow(OpError);
  });
});

const KOD = process.env.KOD_DIR ?? shardsPaths(join(import.meta.dirname, "../../../../.."))?.kod ?? "";

// skipIf still runs the describe body to collect the tests, so the reads wait for the Kod too.
const HAVE_KOD = existsSync(join(KOD, "include", "blakston.khd"));

describe.skipIf(!HAVE_KOD)("editing the server's exits", () => {
  const khd = HAVE_KOD ? readFileSync(join(KOD, "include", "blakston.khd"), "latin1") : "";
  const serverRids = parseRids(khd);
  const files: { path: string; text: string }[] = [];
  const walk = (d: string): void => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (n.endsWith(".kod")) files.push({ path: p, text: readFileSync(p, "latin1") });
    }
  };
  if (HAVE_KOD) walk(join(KOD, "object", "active", "holder", "room"));

  const spec = (e: KodExit): ExitSpec =>
    e.dest === null ? { row: e.row, col: e.col, dest: null, message: e.message } : { row: e.row, col: e.col, dest: e.dest, destRow: e.destRow!, destCol: e.destCol!, rotate: e.rotate };

  it("rewrites every exit as itself without changing what reads back", () => {
    let rewritten = 0;
    for (const f of files) {
      const k = parseKodRoom(f, serverRids);
      if (!k) continue;
      k.exits.forEach((e, i) => {
        // Exits written with expressions (a computed row) aren't the editor's to rewrite.
        if (e.dest !== null && (e.destRow === undefined || e.destCol === undefined)) return;
        let out: string;
        try {
          out = setExit(f.text, i, spec(e));
        } catch (err) {
          // A square listed twice: Kod uses one, the editor won't add another.
          if (err instanceof OpError && /already has an exit/.test(err.message)) return;
          throw err;
        }
        const again = parseKodRoom({ ...f, text: out }, serverRids)!;
        expect(again.exits.map(brief), `${f.path} exit ${i}`).toEqual(k.exits.map((x, j) => (j === i && x.dest !== null && !x.rotate ? brief({ ...x, rotate: "ROTATE_NONE" }) : brief(x))));
        // Only what is between the brackets changes (an exit written over two lines becomes one).
        const st = exitStatements(stripComments(f.text))[i]!;
        expect(out.startsWith(f.text.slice(0, st.open + 1)) && out.endsWith(f.text.slice(st.close))).toBe(true);
        rewritten++;
      });
    }
    expect(rewritten).toBeGreaterThan(500);
  });

  it("opens Marion's crypt gate", () => {
    const marion = files.find((f) => /[\\/]marnrm[\\/]marion\.kod$/.test(f.path));
    if (!marion) return;
    let text = marion.text;
    const locked = () => parseKodRoom({ ...marion, text }, serverRids)!.exits.flatMap((e, i) => (e.dest === null ? [i] : []));
    expect(locked()).toHaveLength(4);
    while (locked().length) text = removeExit(text, locked()[0]!);
    const after = parseKodRoom({ ...marion, text }, serverRids)!;
    expect(after.exits.map((e) => e.dest)).toEqual(["RID_MAR_HEALER_SHOP", "RID_MAR_INN", "RID_MAR_INN", "RID_MAR_HALL", "RID_MAR_SMITHY", "RID_MAR_CRYPT1"]);
    expect(text.split("\r\n").length).toBe(marion.text.split("\r\n").length - 4);
  });
});
