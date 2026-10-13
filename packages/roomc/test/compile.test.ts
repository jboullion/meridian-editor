import { describe, expect, it } from "vitest";
import { checkRoo, PROFILES, readRoo, type TargetProfile } from "@meridian-editor/roo";
import { CompileError, compileRoom, importRoo, type RoomSource } from "../src/index.ts";
import { firstDifference, referenceRooms, type ReferenceRoom, type ReferenceSet } from "../../roo/test/reference.ts";

/** Shipped rooms whose bytes the current roomedit could not have written. */
const KNOWN_DIFFERENCES: Record<string, string> = {
  // Two floor slopes (sectors 116, 117) store a plane 224735 units off their
  // own three points: the points' heights changed after the plane was computed.
  "d6e6ulake.roo": "stale slope planes",
};

const SETS: { set: ReferenceSet; profile: TargetProfile }[] = [
  { set: "original", profile: PROFILES.original },
  { set: "104", profile: PROFILES["104"] },
];

/** roogen's procedural maps were written by its own Python BSP builder, not roomedit. */
const isGenerated = (room: ReferenceRoom): boolean => room.path.replaceAll("\\", "/").includes("/roogen/");

/** Which section a byte offset falls in, from the shipped file's own offsets. */
function sectionAt(bytes: Uint8Array, at: number): string {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const main = view.getInt32(12, true);
  const server = view.getInt32(16, true);
  const names = ["nodes", "client walls", "editor walls", "sidedefs", "sectors", "things"];
  if (at >= server) return "server grids";
  let name = "header";
  names.forEach((n, i) => {
    if (at >= view.getInt32(main + 8 + i * 4, true)) name = n;
  });
  return name;
}

/** Compile, retrying with the older BSPFlipWall if that is what the shipped bytes need. */
function compileLike(src: RoomSource, profile: TargetProfile, shipped: Uint8Array): { bytes: Uint8Array; legacyFlip: boolean } {
  const bytes = compileRoom(src, profile).bytes;
  if (!firstDifference(shipped, bytes)) return { bytes, legacyFlip: false };
  const legacy = compileRoom({ ...src, compat: { ...src.compat, flipKeepsYOffsets: true } }, profile).bytes;
  return firstDifference(shipped, legacy) ? { bytes, legacyFlip: false } : { bytes: legacy, legacyFlip: true };
}

for (const { set, profile } of SETS) {
  const rooms = referenceRooms(set);
  const edited = rooms.filter((r) => !isGenerated(r));
  const generated = rooms.filter(isGenerated);

  describe.skipIf(rooms.length === 0)(`import → compile ${set} rooms`, () => {
    it(`reproduces roomedit's v${profile.version} rooms byte for byte`, () => {
      const failures: string[] = [];
      let total = 0;
      let legacyFlips = 0;
      let compat = 0;
      let skipped = 0;
      for (const room of edited) {
        const bytes = room.bytes();
        const file = readRoo(bytes);
        if (file.version !== profile.version) continue;
        if (room.name in KNOWN_DIFFERENCES) {
          skipped++;
          continue;
        }
        total++;
        try {
          const src = importRoo(file);
          if (src.compat) compat++;
          const out = compileLike(src, profile, bytes);
          if (out.legacyFlip) legacyFlips++;
          const diff = firstDifference(bytes, out.bytes);
          if (diff) failures.push(`${room.name}: ${sectionAt(bytes, Number(/byte (\d+)/.exec(diff)?.[1] ?? 0))}: ${diff}`);
        } catch (e) {
          failures.push(`${room.name}: ${(e as Error).message.split("\n")[0]}`);
        }
      }
      console.log(
        `${set}: ${total - failures.length}/${total} v${profile.version} rooms compile byte for byte ` +
          `(${compat} with imported compat flags, ${legacyFlips} with flipKeepsYOffsets; ${skipped} known difference(s) skipped)`,
      );
      expect(failures.slice(0, 15)).toEqual([]);
    });

    it.skipIf(generated.length === 0)("compiles roogen's generated rooms into rooms that pass checkRoo", () => {
      const failures: string[] = [];
      let matched = 0;
      for (const room of generated) {
        const bytes = room.bytes();
        try {
          const out = compileRoom(importRoo(readRoo(bytes)), profile).bytes;
          if (!firstDifference(bytes, out)) matched++;
          const errors = checkRoo(readRoo(out), profile).filter((i) => i.severity === "error");
          if (errors.length) failures.push(`${room.name}: ${errors[0]!.message}`);
        } catch (e) {
          // _t.roo has negative heights, which 104 can't load: the validator should say so.
          if (!(e instanceof CompileError && e.diagnostics.some((d) => d.message.includes("negative height")))) {
            failures.push(`${room.name}: ${(e as Error).message.split("\n")[0]}`);
          }
        }
      }
      console.log(`${set}: ${generated.length} roogen rooms compile and check clean (${matched} also match roogen's bytes)`);
      expect(failures).toEqual([]);
    });
  });
}
