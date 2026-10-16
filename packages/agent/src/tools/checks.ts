// roomedit's Check menu, the Kod placement check, fixes, and compiling.

import { z } from "zod";
import { checkCrossReferences, checkSectors, checkTextureNames, checkTextures, type CheckIssue } from "../../../../apps/editor/src/renderer/ops/checks.ts";
import { checkKodPlacements } from "../../../../apps/editor/src/renderer/kod/kodChecks.ts";
import { OpError, type Session } from "../session.ts";
import { edited, tool } from "../tool.ts";

const checkedAt = new WeakMap<Session, number>();

const WHICH = ["sectors", "crossrefs", "textures", "names", "kod"] as const;

export async function runChecks(s: Session, which: readonly (typeof WHICH)[number][]): Promise<{ issues: CheckIssue[]; notes: string[] }> {
  const room = s.room();
  const issues: CheckIssue[] = [];
  const notes: string[] = [];
  if (which.includes("sectors")) issues.push(...checkSectors(room));
  if (which.includes("crossrefs")) issues.push(...checkCrossReferences(room));
  if (which.includes("textures")) issues.push(...checkTextures(room));
  if (which.includes("names")) {
    const known = await s.knownTextures();
    if (known) issues.push(...checkTextureNames(room, known));
    else notes.push("Texture names not checked: no texture folder (set texturesDir with set_prefs).");
  }
  if (which.includes("kod")) {
    const k = await s.kodRoom();
    if (k.room) issues.push(...checkKodPlacements(room, k.room));
    else notes.push(`Kod placements not checked: ${k.error}`);
  }
  return { issues, notes };
}

export const checkTools = [
  tool({
    name: "run_checks",
    title: "Run checks",
    description:
      "roomedit's checks (F9): sectors are closed, cross-references, missing textures, unknown texture numbers, and Kod placements outside the room box or off the floor. Each issue has an id; fix_issue applies its fix when it has one.",
    input: { which: z.array(z.enum(WHICH)).optional().describe("Default: all") },
    annotations: { readOnlyHint: true },
    run: async (s, { which }) => {
      const { issues, notes } = await runChecks(s, which ?? WHICH);
      s.setIssues(issues);
      checkedAt.set(s, s.revision());
      return {
        revision: s.revision(),
        errors: issues.filter((i) => i.severity === "error").length,
        warnings: issues.filter((i) => i.severity === "warning").length,
        issues: issues.slice(0, 200).map((i, id) => ({ id, severity: i.severity, message: i.message, item: i.item, at: i.at, fix: i.fix?.label })),
        ...(issues.length > 200 ? { truncated: issues.length - 200 } : {}),
        ...(notes.length ? { notes } : {}),
      };
    },
  }),

  tool({
    name: "fix_issue",
    title: "Fix a check issue",
    description: "Apply the fix offered for an issue from the last run_checks (only while the room hasn't changed since; run the checks again after each fix).",
    input: { id: z.number().int().min(0) },
    edits: true,
    run: (s, { id }) => {
      if (checkedAt.get(s) !== s.revision()) throw new OpError("The room changed since the last run_checks; run it again.");
      const issue = s.lastIssues()[id];
      if (!issue) throw new OpError(`There is no issue ${id}.`);
      if (!issue.fix) throw new OpError(`Issue ${id} has no automatic fix: ${issue.message}`);
      const res = edited(s, issue.fix.label, issue.fix.apply);
      s.setIssues([]);
      return res;
    },
  }),

  tool({
    name: "compile",
    title: "Compile",
    description: "Compile the room for a target and report the result: diagnostics, the .roo version, and BSP node, client wall and sidedef counts. export_roo writes the file.",
    input: { target: z.enum(["104", "original"]).optional() },
    annotations: { readOnlyHint: true },
    run: (s, { target }) => {
      const c = s.compile(target ?? s.target());
      if (!c.ok) return { target: c.target, ok: false, diagnostics: c.diagnostics };
      return {
        target: c.target,
        ok: true,
        version: c.file.version,
        bytes: c.bytes.length,
        nodes: c.file.nodes.length,
        clientWalls: c.file.clientWalls.length,
        sidedefs: c.file.sidedefs.length,
        sectors: c.file.sectors.length,
        ms: Math.round(c.ms),
        diagnostics: c.diagnostics,
      };
    },
  }),
];
