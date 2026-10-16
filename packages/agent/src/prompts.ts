// Ready-made requests for an MCP client's prompt menu: build a room from a
// description, review one, or bring a shipped .roo in as a source.

import { z } from "zod";

export interface Prompt {
  name: string;
  title: string;
  description: string;
  args: z.ZodRawShape;
  text(args: Record<string, string | undefined>): string;
}

export const PROMPTS: Prompt[] = [
  {
    name: "build-room",
    title: "Build a room",
    description: "Build a new room from a description: plan it in Kod squares, draw it, set heights, textures and light, write its Kod, check it and walk it.",
    args: {
      name: z.string().describe("The room's file name (letters, digits, _), also its .roo name"),
      description: z.string().describe("What the room should be"),
    },
    text: ({ name, description }) => `Build a new Meridian room called "${name}" in the room editor.

What it should be: ${description}

Work like this:
1. Read meridian://primer if you haven't. get_status; if the user has the editor open, connect_editor so they can watch.
2. Plan the layout in Kod squares (64 units each): the room box size, each area, its floor and ceiling heights, and how the player gets between them (steps of 24 or less, 48 headroom).
3. new_room (name ${name}, a free roomId), then draw with draw_shape and draw_path; batch related edits. render_map after each stage and check it looks as planned.
4. Heights, textures and light with set_properties; look at candidate textures with view_textures (textures_in_use on a shipped room is a good source of sets that go together). Slopes with add_slope and set_slope.
5. run_checks and fix what they find; compile for 104.
6. walk the routes a player should take, with expect: blocked where they shouldn't get through; fix and repeat.
7. save_room to new/${name}.room.json. kod_new_room with an arrival square, then kod_add_exit and kod_add_object as the description needs. run_checks again (Kod placements).
8. walk with saveAs "${name}" to keep the walk test. If connected, render_3d from the arrival square at noon and at night, and show the user.
9. Say what you built and what's left. Don't run shards_install unless the user asks.`,
  },
  {
    name: "review-room",
    title: "Review a room",
    description: "Look a room over for problems: checks, compile, a map picture, where a player can't walk, and its Kod placements.",
    args: { path: z.string().describe("The room source, such as src/raza.room.json (default: the open room)").optional() },
    text: ({ path }) => `Review ${path ? `the room ${path}` : "the open room"} in the room editor.

1. ${path ? `open_room ${path}.` : "get_status."} room_summary and render_map (with labels where it helps).
2. run_checks (all) and compile for both targets; explain each problem in plain words, with where it is.
3. kod_room: are the arrival square, exits and objects on floors inside the room box?
4. walk from the arrival square to each exit and across each area; report anything a player can't reach and why.
5. Note anything odd: tiny sectors, steps just over 24, ceilings just under 48, walls without textures, impassable two-sided walls.
Don't change the room unless asked; suggest fixes instead.`,
  },
  {
    name: "port-room",
    title: "Import a compiled room",
    description: "Turn a compiled .roo into a room source, and check it recompiles to the same bytes.",
    args: { path: z.string().describe("The .roo file") },
    text: ({ path }) => `Import the compiled room ${path} as a room source.

1. open_room ${path} (it imports as an unsaved source; detected compat quirks show in room_summary).
2. compile for the target the .roo was built for and compare: the shipped rooms recompile byte for byte, so differences mean a quirk the importer doesn't know.
3. render_map and run_checks, and report.
4. Save it only where the user says (rooms/src holds the shipped rooms' sources).`,
  },
];
