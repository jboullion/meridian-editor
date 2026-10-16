// Every editor command has an answer for agents: tools that do it, or a reason
// it has none. Adding a command to commands.tsx fails this until it's covered.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { COMMAND_COVERAGE } from "../src/coverage.ts";
import { TOOLS } from "../src/tools/index.ts";

const COMMANDS = join(import.meta.dirname, "../../../apps/editor/src/renderer/commands.tsx");

/** Command ids from the registry: { id: "..." } entries and the mode()/tool() helpers. */
function commandIds(): string[] {
  const text = readFileSync(COMMANDS, "utf8");
  const ids = [...text.matchAll(/\bid: "([\w.]+)"/g)].map((m) => m[1]!);
  ids.push(...[...text.matchAll(/^\s*mode\("(\w+)"/gm)].map((m) => `mode.${m[1]}`));
  ids.push(...[...text.matchAll(/^\s*tool\("(\w+)"/gm)].map((m) => `tool.${m[1]}`));
  return [...new Set(ids)];
}

describe("command coverage", () => {
  const ids = commandIds();

  it("finds the commands", () => {
    expect(ids.length).toBeGreaterThan(80);
  });

  it("covers every command", () => {
    expect(ids.filter((id) => !COMMAND_COVERAGE[id])).toEqual([]);
  });

  it("names only commands that exist", () => {
    expect(Object.keys(COMMAND_COVERAGE).filter((id) => !ids.includes(id))).toEqual([]);
  });

  it("names only tools that exist", () => {
    const names = new Set(TOOLS.map((t) => t.name));
    const missing = Object.entries(COMMAND_COVERAGE).flatMap(([id, c]) => ("tools" in c ? c.tools.filter((n) => !names.has(n)).map((n) => `${id}: ${n}`) : []));
    expect(missing).toEqual([]);
  });
});
