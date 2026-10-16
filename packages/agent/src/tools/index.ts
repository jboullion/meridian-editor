// Every tool, and batch, which runs several edits as one undo step.

import { z } from "zod";
import { OpError } from "../session.ts";
import { compileSummary, ImageOutput, tool, type ToolDef } from "../tool.ts";
import { checkTools } from "./checks.ts";
import { documentTools } from "./document.ts";
import { drawTools } from "./draw.ts";
import { kodTools } from "./kod.ts";
import { liveTools } from "./live.ts";
import { shardsTools } from "./shards.ts";
import { textureTools } from "./textures.ts";
import { opsTools } from "./ops.ts";
import { propsTools } from "./props.ts";
import { readTools } from "./read.ts";
import { viewTools } from "./view.ts";
import { walkTools } from "./walk.ts";

const base: ToolDef[] = [...documentTools, ...readTools, ...drawTools, ...opsTools, ...propsTools, ...checkTools, ...viewTools, ...walkTools, ...textureTools, ...kodTools, ...shardsTools, ...liveTools];

const byName = new Map(base.map((t) => [t.name, t]));

const batch = tool({
  name: "batch",
  title: "Several edits as one step",
  description:
    "Run edit tools in order as a single undo step, for example draw a room, then set its heights and textures. If any step fails, none of them apply. Indices a step returns can't be used by later steps in the same batch (results arrive at the end), so batch steps whose indices you already know.",
  input: {
    label: z.string().optional().describe("What the batch does, for the undo history"),
    steps: z.array(z.object({ tool: z.string(), args: z.record(z.string(), z.unknown()).optional() })).min(1),
  },
  edits: true,
  run: async (s, { label, steps }) => {
    const results: unknown[] = [];
    await s.transaction(label ?? `${steps.length} edits`, async () => {
      for (const [n, step] of steps.entries()) {
        const t = byName.get(step.tool);
        if (!t?.edits) throw new OpError(`Step ${n}: ${step.tool} ${t ? "isn't an edit tool" : "isn't a tool"}.`);
        const args = z.object(t.input).parse(step.args ?? {});
        const out = await t.run(s, args);
        if (out instanceof ImageOutput) continue;
        // Each step's compile report is stale by the end; the batch reports once.
        const { compile: _c, counts: _n, revision: _r, ...rest } = out;
        results.push({ step: n, tool: step.tool, ...rest });
      }
    });
    return { done: label ?? `${steps.length} edits`, steps: results, revision: s.revision(), compile: compileSummary(s) };
  },
});

export const TOOLS: ToolDef[] = [...base, batch];
