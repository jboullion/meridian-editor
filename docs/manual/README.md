# Meridian Room Editor: user manual

The Meridian Room Editor builds and edits rooms for Meridian 59. You draw a room's floor plan on a map, set its heights, textures and lighting, and check it in a 3D preview that draws the room the way the game client does. You can also walk round it at a player's eye height. When it's ready, the editor compiles the room to a `.roo` file for the server.

![The editor with Raza open: the room list on the left, the map and the 3D preview in the middle, the inspector on the right](images/window.png)

It replaces roomedit, the original Meridian room editor, and keeps roomedit's modes, operations and checks. Rooms you save are compiled the same way roomedit compiles them.

## Contents

1. [Getting started](01-getting-started.md): install the editor and set up textures and Kod.
2. [The editor window](02-the-window.md): what each part of the window is for.
3. [Room basics](03-room-basics.md): vertices, linedefs, sectors, things, units and targets.
4. [Tutorial: your first room](04-tutorial-first-room.md): build a small room with a raised platform, walk it, and export it.
5. [Files](05-files.md): new rooms, opening, importing, saving and exporting.
6. [Selecting and drawing](06-drawing-and-selecting.md): modes, selection, the drawing tools, and moving, copying and deleting.
7. [The inspector](07-inspector.md): every property of rooms, sectors, linedefs, vertices and things, and the texture picker.
8. [Operations](08-operations.md): merging, splitting, doors, lifts, slopes and texture alignment.
9. [3D preview and walking](09-3d-preview-and-walking.md): views, game lighting, light sources and Walk mode.
10. [Kod placements](10-kod-placements.md): see where the room's Kod puts exits, monsters and objects.
11. [Checks and export](11-checks-and-export.md): compile errors, roomedit's checks, Find / change, and exporting a `.roo`.
12. [Working with an AI agent](12-working-with-an-agent.md): let an agent such as Claude Code build, check and walk rooms, on files or in the editor with you.

Reference:
- [Keyboard shortcuts](keyboard-shortcuts.md)
- [Troubleshooting](troubleshooting.md)

## Who this is for

This manual is for room builders. If you're working on the editor itself, the project's [README](../../README.md) covers building from source, the `roomc` command-line compiler, testing rooms on a local Shards server, and the tests.

## About the pictures

The pictures in this manual are taken by a script, so they can be retaken whenever the editor changes:

```bash
npm run shots:manual
```

They show the editor's web build, which is the same as the desktop app apart from the native menu bar and the system file dialogs.
