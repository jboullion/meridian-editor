// What an agent can read for background: a primer on rooms for agents, the
// user manual, the project's agent notes and design record, the open room's
// source and its Kod class.

import { existsSync, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { formatRoomSource } from "@meridian-editor/roomc";
import { kodFilePath, type Session } from "./session.ts";

export const PRIMER = `# Meridian rooms, for agents

## Coordinates and units
- Editor units: 64 per grid square, x east, y **north** (up). Every edit tool takes editor units.
- A grid square is one Kod square: Kod places things by row and column, 1-based, from the room box's top-left corner (row grows south, col east), with fine offsets 0–63 inside a square. convert_coords translates.
- Heights are editor units too. The player is 48 tall and steps up 24 at most. A step over 24, or under 48 headroom, blocks walking. So does a wall side without the passable flag.

## The parts
- Vertices: points. Linedefs: lines between two vertices. Each linedef has a front side (on the right going start→end, y up) and an optional back side; each side faces a sector.
  - One-sided linedef: a solid wall (only its front exists; the normal texture shows).
  - Two-sided linedef: an edge between sectors. "below" textures the face under a higher floor beyond, "above" the face over a lower ceiling beyond. Walking through needs the passable flag on the side you're on.
- Sectors: closed areas with floorHeight, ceilingHeight, floor/ceiling textures (0 = none; no ceiling texture = open sky), light (0–255) and a serverId Kod can use.
- Things: the first two are the room-box corners. They set the room's size and the Kod origin. Server 104 (target "104") loads only rooms with exactly two things.

## Drawing
- draw_shape and draw_path work like the editor's tools: shapes inside a sector make an inner sector (or a pillar), lines split what they cross, and closed faces get sectors. Drawing makes two-sided walls passable by default.
- New sectors and walls take the drawing defaults (get_prefs / set_prefs, or defaults on one call).
- After drawing, set heights and textures with set_properties, and flags with set_flags.

## Indices
Items are addressed by index. Deleting or merging shifts later indices down. Every result carries the room's revision, and edit tools take ifRevision to refuse a stale edit. Re-read (get_items, find_items, describe_sector, render_map) after structural edits.

## A good loop
1. get_status. Then open_room or new_room.
2. Plan in Kod squares, then draw (draw_shape / draw_path), batching related edits.
3. render_map to look; describe_sector for exact outlines and neighbours.
4. set_properties for heights, textures and light; set_flags; set_slope.
5. run_checks (and fix_issue), compile, walk (expect: blocked where it should block).
6. save_room (new rooms in new/<name>.room.json); export_roo for a .roo.

## Targets
"104": Server 104 / Shards (ROO v15, exactly two things, no negative heights). "original": the original server (ROO v13 with movement grids).

## Rules of this project
- Never commit .roo files: they are build output.
- Shipped rooms (rooms/src) recompile byte for byte. Their compat quirks are for imports only; new rooms leave compat unset.
- Kod is read-only here except new rooms' own .kod files (rooms/new/<room>.kod).
`;

interface Doc {
  uri: string;
  name: string;
  title: string;
  description: string;
  read: () => Promise<string>;
}

export function documents(session: Session): Doc[] {
  const root = session.repoRoot;
  const docs: Doc[] = [
    { uri: "meridian://primer", name: "primer", title: "Meridian rooms for agents", description: "Units, coordinates, the parts of a room, indices and a working loop. Read this first.", read: async () => PRIMER },
  ];
  if (!root) return docs;
  const file = (uri: string, name: string, title: string, description: string, path: string): void => {
    if (existsSync(path)) docs.push({ uri, name, title, description, read: () => readFile(path, "utf8") });
  };
  file("meridian://agents", "agents", "Project notes for agents (AGENTS.md)", "Rules for working in this repo: what not to commit, the reference trees, Shards testing.", join(root, "AGENTS.md"));
  file("meridian://adr/0001", "adr-0001", "ADR 0001: the room editor", "Why rooms are text sources compiled to .roo, and the two targets.", join(root, "docs", "0001-room-editor.md"));
  const manual = join(root, "docs", "manual");
  if (existsSync(manual)) {
    for (const f of readdirSync(manual).filter((n) => n.endsWith(".md")).sort()) {
      const slug = f.replace(/\.md$/, "");
      file(`meridian://manual/${slug}`, `manual-${slug}`, `Manual: ${slug}`, "A chapter of the editor's user manual.", join(manual, f));
    }
  }
  return docs;
}

export async function currentRoomSource(session: Session): Promise<string> {
  return session.hasRoom() ? formatRoomSource(session.room()) : "No room is open.";
}

export async function currentKodSource(session: Session): Promise<string> {
  const k = await session.kodRoom();
  const lib = await session.kod();
  if (!k.room || !lib.index) return k.error ?? "No Kod class for this room.";
  return readFile(kodFilePath(session, lib.index.dir, k.room.path), "latin1");
}
