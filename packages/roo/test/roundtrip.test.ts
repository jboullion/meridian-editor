import { basename } from "node:path";
import { describe, expect, it } from "vitest";
import { checkRoo, computeSecurity, readRoo, writeRoo } from "../src/index.ts";
import { firstDifference, KNOWN_BAD_SECURITY, referenceRooms, type ReferenceSet } from "./reference.ts";

const SETS: { set: ReferenceSet; versions: number[] }[] = [
  { set: "original", versions: [12, 13] },
  { set: "104", versions: [15] },
];

for (const { set, versions } of SETS) {
  const rooms = referenceRooms(set);

  describe.skipIf(rooms.length === 0)(`${set} reference rooms (${rooms.length})`, () => {
    it("read and write back byte for byte, with the checksum recomputed", () => {
      const failures: string[] = [];
      const byVersion = new Map<number, number>();
      for (const room of rooms) {
        const bytes = room.bytes();
        try {
          const file = readRoo(bytes);
          byVersion.set(file.version, (byVersion.get(file.version) ?? 0) + 1);
          if (!versions.includes(file.version)) failures.push(`${room.name}: unexpected v${file.version}`);
          const knownBad = KNOWN_BAD_SECURITY.has(basename(room.path));
          const out = writeRoo(file, { security: knownBad ? "stored" : "computed" });
          const diff = firstDifference(bytes, out);
          if (diff) failures.push(`${room.name}: ${diff}`);
        } catch (e) {
          failures.push(`${room.name}: ${(e as Error).message}`);
        }
      }
      const tally = [...byVersion].map(([v, n]) => `${n} × v${v}`).join(", ");
      console.log(`${set}: ${rooms.length - failures.length}/${rooms.length} round-trip (${tally})`);
      expect(failures.slice(0, 20)).toEqual([]);
    });

    it("pass checkRoo for their own target", () => {
      const failures: string[] = [];
      for (const room of rooms) {
        if (KNOWN_BAD_SECURITY.has(basename(room.path))) continue;
        const errors = checkRoo(readRoo(room.bytes())).filter((i) => i.severity === "error");
        if (errors.length) failures.push(`${room.name}: ${errors.map((e) => e.message).join("; ")}`);
      }
      expect(failures.slice(0, 20)).toEqual([]);
    });

    it("keeps the known bad checksum detectable", () => {
      for (const room of rooms) {
        if (!KNOWN_BAD_SECURITY.has(basename(room.path))) continue;
        const file = readRoo(room.bytes());
        expect(computeSecurity(file)).not.toBe(file.security);
      }
    });
  });
}
