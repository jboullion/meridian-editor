// Shards' rooms: every source in shards-server's resource/rooms/src must compile to
// the .roo committed beside it, so the sources and the files the server loads never
// drift apart. Skipped without the Shards checkout (shardsPaths.ts).

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PROFILES } from "@meridian-editor/roo";
import { shardsPaths } from "../../../apps/editor/src/main/shardsPaths.ts";
import { compileRoom, parseRoomSource } from "../src/index.ts";
import { firstDifference } from "../../roo/test/reference.ts";

const SUFFIX = ".room.json";
const paths = shardsPaths(join(import.meta.dirname, "../../.."));
const sources = paths && existsSync(paths.rooms) ? readdirSync(paths.rooms).filter((f) => f.endsWith(SUFFIX)) : [];

describe.skipIf(sources.length === 0)("Shards' room sources", () => {
  it("each compiles for 104 to the .roo committed beside it", () => {
    const failures: string[] = [];
    for (const f of sources) {
      const name = f.slice(0, -SUFFIX.length);
      const roo = join(paths!.roo, `${name}.roo`);
      if (!existsSync(roo)) {
        failures.push(`${name}: no ${name}.roo beside the source`);
        continue;
      }
      try {
        const out = compileRoom(parseRoomSource(readFileSync(join(paths!.rooms, f), "utf8")), PROFILES["104"]).bytes;
        const diff = firstDifference(new Uint8Array(readFileSync(roo)), out);
        if (diff) failures.push(`${name}: ${diff}`);
      } catch (e) {
        failures.push(`${name}: ${(e as Error).message.split("\n")[0]}`);
      }
    }
    expect(failures.slice(0, 15)).toEqual([]);
  });
});
