// How a tool is defined, and the pieces most tools share: schemas for items and
// points, the revision check, and the summary every edit returns.

import { z } from "zod";
import type { RoomSource } from "@meridian-editor/roomc";
import { countOf, OpError, type Session } from "./session.ts";

/** A picture for the agent to look at, with notes about it. */
export class ImageOutput {
  readonly png: Uint8Array;
  readonly info: Record<string, unknown>;
  constructor(png: Uint8Array, info: Record<string, unknown>) {
    this.png = png;
    this.info = info;
  }
}

export type ToolOutput = Record<string, unknown> | ImageOutput;

export interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface ToolDef {
  name: string;
  title: string;
  description: string;
  input: z.ZodRawShape;
  annotations?: ToolAnnotations;
  /** Edits the room: runs as one undo step and can be part of a batch. */
  edits?: boolean;
  /** Runs without syncing with the editor first (connecting and disconnecting). */
  raw?: boolean;
  run(session: Session, args: Record<string, unknown>): ToolOutput | Promise<ToolOutput>;
}

export function tool<S extends z.ZodRawShape>(def: {
  name: string;
  title: string;
  description: string;
  input: S;
  annotations?: ToolAnnotations;
  edits?: boolean;
  raw?: boolean;
  run(session: Session, args: z.infer<z.ZodObject<S>>): ToolOutput | Promise<ToolOutput>;
}): ToolDef {
  return def as unknown as ToolDef;
}

// ---------------------------------------------------------------- shared schemas

export const kind = z.enum(["vertex", "linedef", "sector", "thing"]).describe("Item kind");
export const index = z.number().int().min(0);
export const indices = z.array(index).min(1).describe("Item indices (0-based), in the order an operation needs them");
export const coord = z.number().describe("Editor units: 64 per grid square, x east, y north");
export const point = z.tuple([z.number(), z.number()]).describe("[x, y] in editor units");
export const ifRevision = z
  .number()
  .int()
  .optional()
  .describe("Fail unless the room is still at this revision (from get_status or any earlier result); guards against stale indices");

export const drawDefaults = z
  .object({
    floorHeight: z.number().int(),
    ceilingHeight: z.number().int(),
    floorTexture: z.number().int().min(0),
    ceilingTexture: z.number().int().min(0),
    light: z.number().int().min(0).max(255),
    wallTexture: z.number().int().min(0),
    upperTexture: z.number().int().min(0),
    lowerTexture: z.number().int().min(0),
    passable: z.boolean(),
  })
  .partial()
  .optional()
  .describe("Override the drawing defaults (get_prefs) for this call only: what new sectors and walls start as");

// ---------------------------------------------------------------- edits

export function checkRevision(session: Session, expected: number | undefined): void {
  if (expected !== undefined && expected !== session.revision()) {
    throw new OpError(`The room changed since revision ${expected} (it is at ${session.revision()}). Read it again before editing by index.`);
  }
}

export function needIndices(room: RoomSource, k: z.infer<typeof kind>, list: readonly number[]): void {
  const n = countOf(room, k);
  const bad = list.filter((i) => i >= n);
  if (bad.length) throw new OpError(`There is no ${k} ${bad.join(", ")}: the room has ${n} ${k}s (0–${n - 1}).`);
}

function counts(room: RoomSource): Record<string, number> {
  return { vertices: room.vertices.length, linedefs: room.linedefs.length, sectors: room.sectors.length, things: room.things.length };
}

/**
 * Run an edit and say what it did: the new revision, how the item counts moved,
 * and whether the room still compiles for the current target.
 */
export function edited(session: Session, label: string, fn: (room: RoomSource) => RoomSource, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const before = counts(session.room());
  const changed = session.apply(label, fn);
  const after = counts(session.room());
  const delta = Object.fromEntries(Object.entries(after).flatMap(([k, v]) => (v !== before[k] ? [[k, v - before[k]!]] : [])));
  return { done: label, changed, ...extra, revision: session.revision(), counts: after, ...(Object.keys(delta).length ? { delta } : {}), compile: compileSummary(session) };
}

/** Errors and warnings for the current target, briefly. */
export function compileSummary(session: Session): Record<string, unknown> {
  const c = session.compile();
  const errors = c.diagnostics.filter((d) => d.severity === "error").map((d) => d.message);
  const warnings = c.diagnostics.filter((d) => d.severity === "warning").map((d) => d.message);
  return {
    target: c.target,
    ok: c.ok,
    ...(errors.length ? { errors: errors.slice(0, 10) } : {}),
    ...(warnings.length ? { warnings: warnings.length > 5 ? [...warnings.slice(0, 5), `…and ${warnings.length - 5} more`] : warnings } : {}),
  };
}
