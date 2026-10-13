#!/usr/bin/env node
// roomc: compile room sources to .roo, import .roo to room sources, verify .roo files.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parseArgs } from "node:util";
import { checkRoo, getProfile, profileForVersion, readRoo, type RooFile, type TargetProfile } from "@meridian-editor/roo";
import { CompileError, compileRoom } from "./compile.ts";
import { formatRoomSource, parseRoomSource } from "./format.ts";
import { importRoo } from "./import.ts";
import type { Diagnostic, RoomSource } from "./source.ts";

const USAGE = `usage:
  roomc compile <src.room.json> --target original|104 [-o out.roo]
  roomc import <in.roo> [-o out.room.json]
  roomc import <in.roo>... -d <out-dir>
  roomc verify <file.roo>... [--target original|104]

targets:
  104       Server 104 and Shards: ROO v15, no server grids, exactly two things
  original  Original server: ROO v13 with server movement grids`;

class UsageError extends Error {}

function main(argv: string[]): number {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      target: { type: "string", short: "t" },
      output: { type: "string", short: "o" },
      "out-dir": { type: "string", short: "d" },
      help: { type: "boolean", short: "h" },
    },
  });
  const [command, ...files] = positionals;
  if (values.help || !command) {
    console.log(USAGE);
    return values.help ? 0 : 2;
  }

  switch (command) {
    case "compile":
      return compile(one(files), values.target, values.output);
    case "import":
      if (values["out-dir"]) return importMany(files, values["out-dir"]);
      return importCommand(one(files), values.output);
    case "verify":
      if (files.length === 0) throw new UsageError("verify needs at least one .roo file");
      return verify(files, values.target);
    default:
      throw new UsageError(`unknown command "${command}"`);
  }
}

function one(files: string[]): string {
  if (files.length !== 1) throw new UsageError("expected exactly one input file");
  return files[0]!;
}

function compile(input: string, target: string | undefined, output: string | undefined): number {
  if (!target) throw new UsageError("compile needs --target original|104");
  const profile = getProfile(target);
  const src = parseRoomSource(readFileSync(input, "utf8"));
  const out = output ?? input.replace(/(\.room)?\.json$/i, "") + ".roo";
  try {
    const result = compileRoom(src, profile);
    printDiagnostics(result.diagnostics);
    writeFileSync(out, result.bytes);
    const f = result.file;
    console.log(
      `${out}: v${f.version} for ${profile.name}, ${f.nodes.length} nodes, ${f.clientWalls.length} walls, ` +
        `${f.sidedefs.length} sidedefs, ${f.sectors.length} sectors, ${f.width / 1024}×${f.height / 1024} squares`,
    );
    return 0;
  } catch (e) {
    if (e instanceof CompileError) {
      printDiagnostics(e.diagnostics);
      return 1;
    }
    throw e;
  }
}

interface Imported {
  out: string;
  src: RoomSource;
  /** "exact" if recompiling reproduces the input, "upgrade" if the input is an older version of its family. */
  recompile: "exact" | "upgrade" | "differs";
}

function importOne(input: string, out: string): Imported {
  const bytes = new Uint8Array(readFileSync(input));
  const file = readRoo(bytes);
  const profile = profileForVersion(file.version);
  const src = importRoo(file);
  const exact = detectLegacyFlip(src, file, bytes, profile);
  writeFileSync(out, formatRoomSource(src));
  return { out, src, recompile: file.version !== profile.version ? "upgrade" : exact ? "exact" : "differs" };
}

function importCommand(input: string, output: string | undefined): number {
  const file = importOne(input, output ?? input.replace(/\.roo$/i, "") + ".room.json");
  const { src } = file;
  const compat = src.compat ? ` (compat: ${Object.keys(src.compat).join(", ")})` : "";
  console.log(`${file.out}: ${src.vertices.length} vertices, ${src.linedefs.length} linedefs, ${src.sectors.length} sectors${compat}`);
  if (file.recompile === "upgrade") console.log("note: older version; compiling writes its family's current version");
  else if (file.recompile === "exact") console.log("recompiles byte for byte");
  else console.log(`note: recompiling won't reproduce ${basename(input)} exactly`);
  return 0;
}

function importMany(inputs: string[], outDir: string): number {
  if (inputs.length === 0) throw new UsageError("import needs at least one .roo file");
  mkdirSync(outDir, { recursive: true });
  const counts = { exact: 0, upgrade: 0, differs: 0, failed: 0 };
  for (const input of inputs) {
    try {
      const file = importOne(input, join(outDir, basename(input).replace(/\.roo$/i, "") + ".room.json"));
      counts[file.recompile]++;
      if (file.recompile === "differs") console.log(`${basename(input)}: recompiling won't reproduce it exactly`);
    } catch (e) {
      counts.failed++;
      console.log(`${basename(input)}: ${(e as Error).message}`);
    }
  }
  console.log(
    `${outDir}: imported ${inputs.length - counts.failed}/${inputs.length}; ` +
      `${counts.exact} recompile byte for byte, ${counts.upgrade} older-version, ${counts.differs} differ`,
  );
  return counts.failed ? 1 : 0;
}

/**
 * Some shipped rooms were saved by a roomedit whose BSP flips kept y offsets.
 * Only a compile can tell, so try both and keep the one that matches.
 */
function detectLegacyFlip(src: RoomSource, file: RooFile, bytes: Uint8Array, profile: TargetProfile): boolean {
  if (file.version !== profile.version) return false;
  const same = (b: Uint8Array): boolean => b.length === bytes.length && b.every((v, i) => v === bytes[i]);
  try {
    if (same(compileRoom(src, profile).bytes)) return true;
    const legacy = { ...src, compat: { ...src.compat, flipKeepsYOffsets: true } };
    if (same(compileRoom(legacy, profile).bytes)) {
      src.compat = legacy.compat;
      return true;
    }
  } catch {
    // Rooms the target can't hold (such as negative heights on 104) still import.
  }
  return false;
}

function verify(files: string[], target: string | undefined): number {
  let failed = 0;
  for (const path of files) {
    let errors: number;
    try {
      const file = readRoo(new Uint8Array(readFileSync(path)));
      const profile = target ? getProfile(target) : profileForVersion(file.version);
      const issues = checkRoo(file, profile);
      errors = issues.filter((i) => i.severity === "error").length;
      console.log(`${path}: v${file.version}, ${profile.name}: ${errors ? `${errors} error(s)` : "ok"}`);
      for (const i of issues) console.log(`  ${i.severity}: ${i.message}`);
    } catch (e) {
      errors = 1;
      console.log(`${path}: ${(e as Error).message}`);
    }
    if (errors) failed++;
  }
  if (files.length > 1) console.log(`${files.length - failed}/${files.length} ok`);
  return failed ? 1 : 0;
}

function printDiagnostics(diagnostics: Diagnostic[]): void {
  for (const d of diagnostics) console.error(`${d.severity}: ${d.message}`);
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (e) {
  if (e instanceof UsageError) {
    console.error(`roomc: ${e.message}\n\n${USAGE}`);
    process.exitCode = 2;
  } else {
    console.error(`roomc: ${(e as Error).message}`);
    process.exitCode = 1;
  }
}
