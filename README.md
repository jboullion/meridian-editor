# meridian-editor

A room editor for Meridian 59. Rooms are kept as text sources (`.room.json`) and compiled to `.roo` for one of two servers:

| Target | Server | Output |
|---|---|---|
| `104` | Server 104, which Shards runs | ROO v15, 104 checksum, no server grids, exactly two corner things |
| `original` | The original server (MeridianSteam) | ROO v13, original checksum, server movement grids |

The design and its reasons are in [docs/0001-room-editor.md](docs/0001-room-editor.md).

**Using the editor?** The [user manual](docs/manual/README.md) covers installing it, building a first room, and every tool, with pictures.

## The editor

```bash
npm run editor
```

That opens the Electron app with hot reload. To run the same UI in a browser at http://127.0.0.1:5174 instead (rooms are read and saved through the dev server):

```bash
npm run editor:web
```

How it works:
- **Modes:** T things, V vertices, L linedefs, S sectors (Tab cycles), as in roomedit. Clicks and box-selects pick the current mode's items.
- **Tools:**
  - *Select* (Q): click, Shift-click to add, drag a box; drag the selection to move it.
  - *Draw lines* (D): click points; clicking the first point closes a sector, and a double-click or Enter finishes an open line. Lines snap to vertices, walls and the grid, split the walls they cross, and divide the sectors they cut.
    - Walls that drawing makes two-sided are made passable (`WF_PASSABLE`). roomedit left the flag off, which makes a drawn step a solid wall in the game. The Preference can turn this off.
  - *Rectangle* (R), *Polygon* (4), *Circle* (5): drag them out. Inside a sector they make an inner sector, or a pillar if set in Preferences.
  - *Torch* (6) and *Thing* (7): click to place.
- **Operations:** right-click the map for the current mode's roomedit operations, or press Ctrl+Shift+P for every command. They're also in the menus.
- **Inspector:** every field of the selection. With several items selected, a change applies to all of them, and fields where they differ show "mixed". Texture fields have thumbnails and open the texture picker.
- **Checks** (F9): roomedit's sector, cross-reference and texture checks. Results link to the problem, and some come with a Fix button.
- **Textures:** `grdNNNNN.bgf` from Shards' asset build (`meridian-browser/dist/assets`, what our clients get), else the installed Meridian 104 client (`%LOCALAPPDATA%\Meridian-104\resource`), or a folder set in Preferences.
- **Map display:** sectors are shaded by floor height, ceiling height or light, using the live compiled BSP. The status bar shows the cursor's Kod row and column.
- **Kod placements** (K toggles them on the map), read-only, from the room's class in the server's Kod:
  - What's shown:
    - exits (green squares) and locked doors (red);
    - edge exits along the room box;
    - monster generators;
    - objects from `NewHold` and ornament lists;
    - looping sounds;
    - the arrival square.
  - The **Kod** tab in the bottom panel lists them, each linked to its spot. The status bar names what's on the square under the cursor.
  - *Check Kod placements* (also part of F9) flags placements outside the room box or where there's no floor. Moving the room box corners or walls is the usual cause.
  - *Copy Kod position here* (right-click) copies `#new_row=…,#new_col=…,#fine_row=…,#fine_col=…` for pasting into Kod.
  - The class is found by the room's `.roo` name, or by its room ID. When several classes share one `.roo` (`tos.roo`), the tab lets you pick.
  - The Kod comes from the Shards server (shards-server's `kod`, through `meridian-browser/server/src` beside this repo), or the folder set in Preferences.
- **3D preview:** textured the way the client draws rooms, using the client's own wall, floor and ceiling extraction (`d3drender.c`, through meridian-browser's port).
  - Texture offsets, top-down/bottom-up, no-vtile, backwards, slopes, bowties, see-through walls, and scrolling and cycling animations all work.
  - Faces with no texture show a grey checker; open sky has no ceiling.
  - **Lighting is the client's**: palette textures lit from each sector's light, the room's ambient light and the player's light, with sun shading on walls and slopes. While walking, there's also fog. The shader is ported from Shards' `lighting.ts`.
    - Pick a game hour from the toolbar menu. The ambient light, the sun's direction and its shading follow the server's own formulas:
      - `room.kod GetRoomLight`, using the room class's `piBaseLight` and `piOutside_factor` (inherited, and its own constants, included);
      - `system.kod` brightness;
      - `sun.kod`;
      - `RecalculateDirectionalLight`, using `piDirectional_percent`.
    - The bar under the view says what it used. Hover it to see where each value comes from.
    - Checked against the running server: Tos (ambient 255, shading 23) and the Bowmaker's Hut (ambient 182) at hour 17 match what it sends.
    - *Flat light* shows each sector's light level instead.
    - *View → Lighting…* sets the player's light (5 unless a spell or item changes it) and fog.
    - **Light sources:** the objects the room's Kod places that give light, drawn as the client's light maps (`d3dlighting.c`). The map's Kod overlay shows how far each one reaches.
      - Candles, braziers, lamps, torches and `DynamicLight`s: their class's light properties, or the `Create` arguments.
      - Lamps switch off from 11:00 to 17:00 outdoors, as `lamp.kod` does.
      - Flickering ornaments, signs (a small highlight light) and news globes.
      - Each light sits at the top of its object's sprite, read from the client's resource folder.
      - Checked against the server's own lights in the Raza inn, the Bowmaker's Hut and Tos (its seven lamps at night).
      - Lights that depend on the game's state (spells, monsters, the Tos fountain) aren't shown.
  - Click any surface to select its sector.
- **Walk mode** (Walk, or Shift+W; *Walk from here* on the map's right-click menu): walk the room at a player's eye height.
  - The movement rules are the client's, so steps over 24, low ceilings, walls without `WF_PASSABLE` and the room's edge stop you where the game would. It's a port of `move.c`, through Shards' `PlayerMover`, and is tested frame by frame against it.
  - The camera uses the client's eye height and field of view.
  - Controls: WASD or the arrows, Shift to run, drag to look, PgUp/PgDn/Home to look up and down, Esc to stop.
  - It starts on the Kod arrival square. The map shows where you are and which way you face.
  - Edits apply while you walk; ceilings always show.
- **Compile:** the room recompiles for the chosen target (104 or Original) in a worker after every change. *Export .roo* (Ctrl+E) writes the file, by default to `rooms/out`.
- **Files:** New (Ctrl+N), Open (Ctrl+O; `.room.json`, or a `.roo` to import), Save (Ctrl+S). Undo and redo are Ctrl+Z / Ctrl+Y.

### roomedit parity

| roomedit | Here |
|---|---|
| Create level, Open, Save, Save As, Set Room ID | New, Open, Save, Save As; Room ID in the inspector |
| Undo, Redo, Edit object(s), Copy, Add, Delete | Undo/redo; inspector (one or many); Copy/Cut/Paste/Duplicate; Insert and the tools; Delete (with roomedit's cascades) |
| Insert standard object: rectangle, polygon, circle, torch | Rectangle, Polygon, Circle and Torch tools |
| Modes: Things, Vertices, LineDefs, Sectors | The same, T/V/L/S, Tab / Shift+Tab |
| Search: Find/Change, Next/Previous object, Jump to object | Find / change (Ctrl+F), N / P, Ctrl+J |
| Check: statistics, sectors closed, cross-references, missing textures, texture names | Check menu and F9, with a results panel |
| Window: centre map, zoom, grid, snap | C, +/−, G / Shift+G, H, Shift+H, F to fit |
| Misc (vertices): rotate/scale, delete and join, merge, add linedef and split sector | All of these |
| Misc (linedefs): rotate/scale, split, split with sector, delete and join sectors, flip, swap sides, align Y, align X (incl. "circle") | All of these, plus make a sector from linedefs |
| Misc (sectors): rotate/scale, free tag, make door, make lift, distribute floor/ceiling heights | All of these. Free tag gives a free sector server id; door and lift are adapted to Meridian (closed, and a server id for Kod) |
| Insert key specials: link selected vertices, add sector to selected linedefs | Insert / Shift+Insert in Vertices mode; *Make a sector from linedefs* |
| AutoMergeVertices after a move | Dropping a vertex on a vertex merges them; dropping it on a wall splits the wall |
| View wall textures | Texture browser and pickers |
| 3D preview ("not yet implemented" in roomedit) | A live, textured 3D preview |

Not carried over:
- Doom leftovers: linedef tags and types, and Doom door/lift textures.
- roomedit's info-window layouts.
- Kod object names in the thing dialog. Things show numeric types; Kod remains where placements live.

To build and start the app without the dev server:

```bash
npm run build -w @meridian-editor/app
```

```bash
npm run start -w @meridian-editor/app
```

### Installers

The editor packages like the Shards desktop app (electron-builder, `apps/editor/electron-builder.yml`), with the Shards logo (`apps/editor/build/icon.png`, from meridian-browser's `apps/desktop/build/icon.png`). To build the installer for this OS, into `apps/editor/release/`:

```bash
npm run editor:dist
```

To build just an unpacked app, for testing (`release/win-unpacked/Meridian Room Editor.exe` on Windows):

```bash
npm run editor:pack
```

- **Windows:** an NSIS installer (`Meridian-Room-Editor-Setup-<version>.exe`). Per-user, with a choice of folder and a desktop shortcut. It isn't code-signed, so Windows SmartScreen warns on first run.
- **macOS:** a universal DMG and zip. **Linux:** an AppImage and a deb. Each must be built on its own OS. Shards does this with a GitHub workflow (`.github/workflows`), which this repo could copy once it has a GitHub repo.
- **Contents:** only the bundled renderer, main process and preload, under Electron fuses as in Shards (no `--inspect`, no `ELECTRON_RUN_AS_NODE`, asar integrity checked).
- **Installed, the editor has no repo around it:**
  - Rooms default to `Documents/Meridian Rooms`. The folder you open is remembered, in `settings.json` in the app's data folder (`%APPDATA%/Meridian Room Editor`), as is the export folder.
  - Set the Kod folder (Shards' `server/src/kod`) in Preferences to see Kod placements, room lights and light sources.
  - Textures still come from the installed Meridian client.
- **Opening rooms from the file manager:** file managers go by a file's last extension only, so a room source (`.room.json`) counts as `.json`. Making the editor *the* `.json` program would open every JSON file in it. Instead:
  - *Windows:* "Open with → Meridian Room Editor" for `.json` and `.roo` files (`build/installer.nsh`). You can also drop a file on the editor's icon.
  - *macOS:* the editor is an alternate handler for `.json` and `.roo`, under Open With.
  - *Linux:* the editor is offered for JSON.
  - A room opens in the running editor if there is one. A `.roo` is imported, as with File → Open.
- The version is `apps/editor/package.json`'s. Code signing and auto-updates (through GitHub releases) are planned: see [TODO.md](TODO.md).

## Testing rooms in Shards

`tools/shards` puts a room from `rooms/new` on the local Shards stack (meridian-browser beside this repo, or `MERIDIAN_BROWSER`) and walks it. It needs blakserv and the gateway running (`npm run dev` there).

```bash
npm run shards:install -- edtest
```

```bash
npm run shards:walk -- edtest
```

- **install:**
  - Compiles `rooms/new/<room>.room.json` for 104.
  - Copies the `.roo` to the server's `rooms` folder and to `dist/assets`, listed in the manifest.
  - Creates the room on the running server, or recreates it so it loads the new file.
  - The first time, or when the `.kod` changed, it also:
    - copies `rooms/new/<room>.kod` into the server's Kod tree;
    - builds the Kod (`server\build.cmd Bkod`);
    - reloads it (`reload system`, which saves the game first);
    - rebuilds the assets, so clients get the new `rsc0000.rsb`.
  - It writes into shards-server (the Kod, the room makefile, the run folder), where changes are tracked for you to commit, and into meridian-browser's git-ignored `dist/assets`.
- **walk:**
  - Logs in as `shardpal` through the gateway, using meridian-browser's protocol code. Use an account nobody is playing, since logging in takes over its session.
  - Has the server teleport the character into the room, and checks that the server's checksum matches the compiled file.
  - Walks each step of `rooms/new/<room>.walk.json` with Shards' own port of the client's `move.c`, facing the target with forward held, and sends its moves to the server like the game does.
  - A step expects to be reached, or `"blocked"` (the mover stops, or the server puts the character back). `"go": true` takes the exit underfoot.
- **Why the client's movement code:** the 104 server doesn't check players against walls, steps or ceilings. Kod leaves that to the client (`room.kod:2372`), and only refuses a spot outside every sector.

`edtest` (RID 4200, exit to Tos) checks a 16-unit step, a 64-unit ledge, a ramp up to it, a solid pillar, a 40-high tunnel and the exit. All 19 checks pass.

## Packages

- `packages/roo`: the `.roo` format.
  - A lossless reader for v12-v15 and a writer.
  - Both checksum rules.
  - The two target profiles, and `checkRoo`, which reports what a target's client or server would reject.
- `packages/roomc`: the room source format, plus `import` (a port of roomedit's `load.cpp`) and `compile`.
  - `compile` ports roomedit's `save.cpp` and `bspmake.cpp`, plus `move.cpp` for the original target's grids.
- `apps/editor`: the Electron app.
  - `src/main` is the main process and preload.
  - `src/renderer` is the React UI, with three.js for the 3D preview.
  - `src/renderer/ops` holds roomedit's operations as pure functions, with tests: drawing and sector detection, delete cascades, merge/join/split, door/lift, alignment, checks and shapes.
  - `src/renderer/commands.tsx` is the one registry behind shortcuts, menus, the context menu and the palette.
- `packages/agent`: an MCP server that gives AI agents the editor's operations (see [AI agents](#ai-agents)).

## AI agents

`packages/agent` is an MCP server, so agents such as Claude Code can build and edit rooms with the editor's own operations:

```bash
npm run mcp
```

Claude Code picks it up from `.mcp.json` in this repo. It starts headless, on files in `rooms/` (`--rooms <dir>` or `EDITOR_ROOMS_DIR` for another folder), with one room open at a time and its own undo history.

**Working in the open editor:** `connect_editor` attaches to the editor you have open (`npm run editor`, or `npm run editor:web` with the page open), and from then on every tool works on the room open there.
- You see each change as it's made. Each tool call (or `batch`) is one undo step, and the status bar says what the agent did ("Agent: draw rectangle").
- If you edit the room while the agent is working on it, your edit wins: the agent's change is refused and it reads the room again.
- Only there: `render_3d` (a picture from the 3D preview, from any spot at eye level, at any game hour), `screenshot_window` (desktop app), `select`, `set_view`, `set_lighting`, `set_display`, `walk_live` and `notify`.
- `disconnect_editor` goes back to files.
- How it works: the editor runs a small endpoint on 127.0.0.1 (the main process, or the dev server for the web build) and writes its address and a token to `agent.json` (or `agent-web.json`) in the editor's data folder. The agent reads the room's state before each tool call and sends the changed room back afterwards.

- **Tools** cover what the editor's commands, map tools and inspector do: open, new, save and export; drawing lines and shapes; every roomedit operation; setting fields and flags (by name); slopes; checks and their fixes; compiling.
  - Reading tools describe the room for an agent: `describe_sector` gives a sector's outline, holes and neighbours, with the steps and headroom between them; `at_point` and `convert_coords` translate between editor units and Kod squares.
  - `render_map` returns a picture of the map with index labels; `view_textures` a labelled contact sheet of textures (their numbers have no names).
  - `walk` walks the room with the 3D preview's `Walker` (the client's `move.c`) and says what stopped the player and why; `saveAs` keeps the route as a `.walk.json`.
  - Kod: `kod_room` and `kod_lights` read the room's class; for new rooms only, `kod_new_room`, `kod_add_exit`, `kod_add_object` and `kod_set` write `rooms/new/<room>.kod` (and the tools read it ahead of the server's copy).
  - Shards: `shards_status`, `shards_install` (asks the user every time: it reloads the server's Kod, which saves the game) and `shards_walk` (only as `shardpal`, and not while it's logged in).
  - Each tool call is one undo step; `batch` makes several one step. Results carry the room's revision, and edits take `ifRevision` so a stale index fails instead of editing the wrong item.
- **Resources and prompts:** a primer on rooms for agents (`meridian://primer`), the user manual, AGENTS.md, the ADRs, the open room's source and its Kod class; and the prompts `build-room`, `review-room` and `port-room`.
- `packages/agent/src/coverage.ts` maps every editor command to the tools that do it; a test fails when a new command has no entry.

**Working in the open editor:** `connect_editor` attaches to the editor you have open (`npm run editor`, or `npm run editor:web` with the page open), and from then on every tool works on the room open there.
- You see each change as it's made. Each tool call (or `batch`) is one undo step, and the status bar says what the agent did ("Agent: draw rectangle").
- If you edit the room while the agent is working on it, your edit wins: the agent's change is refused and it reads the room again.
- Only there: `render_3d` (a picture from the 3D preview, from any spot at eye level, at any game hour), `screenshot_window` (desktop app), `select`, `set_view`, `set_lighting`, `set_display`, `walk_live` and `notify`.
- `disconnect_editor` goes back to files.

The design and its reasons are in [docs/0002-agent-tools.md](docs/0002-agent-tools.md); the user's side is in the manual's [Working with an AI agent](docs/manual/12-working-with-an-agent.md).

## roomc

```bash
npm run roomc -- import path/to/room.roo -o room.room.json
```

```bash
npm run roomc -- compile room.room.json --target 104 -o room.roo
```

```bash
npm run roomc -- verify room.roo
```

- **import** reads any version from 12 to 15. It reports whether recompiling for the room's own target reproduces the file byte for byte.
- **compile** validates against the target first. For example, it rejects more than two things, negative heights or original-only wall flags on `104`.
- **verify** checks magic, version, checksum, references, the things rule and wall flags against the file's target, or against `--target`.

## Rooms

- **Shards' rooms** live in the shards-server repository, which meridian-browser's `server/src` links to (`apps/editor/src/main/shardsPaths.ts`; `MERIDIAN_BROWSER` or `SHARDS_SERVER` to move it):
  - `resource/rooms/src/*.room.json` holds the sources: 357 rooms from `roomc import -d`. It's the editor's default folder.
  - `resource/rooms/*.roo` holds the compiled rooms, committed beside them. The server build copies these to its run folder.
  - `packages/roomc/test/shardsRooms.test.ts` checks that each source compiles to its `.roo` byte for byte.
  - `d6e6ulake` has no source, since its slopes can't be reproduced.
- **`rooms/new/`:** rooms made here, each with its Kod class (`.kod`) and a walk test (`.walk.json`). `edtest` is the editor's test room.
- **`rooms/out/`:** where the editor exports compiled rooms by default.

## Development

Node 24 or later. Install once with `npm install`. Before committing, run:

```bash
npm run check
```

That runs typecheck, lint and tests. Tests that use the shipped rooms read them from `meridian-unreal/ReferenceServers` by default. Point `ROO_ORIGINAL_DIR` and `ROO_104_DIR` elsewhere if needed; those tests skip when the rooms are missing.

What the tests check:
- **Read → write:** reproduces all 265 original rooms (v12 and v13) and all 400 Server 104 rooms byte for byte, with the checksum recomputed.
- **Import → compile, original:** reproduces all 143 v13 rooms byte for byte, server grids included.
- **Import → compile, 104:** reproduces all 381 roomedit-made v15 rooms byte for byte. The one exception, `d6e6ulake.roo`, stores slope planes that don't pass through their own points.
- **roogen:** the 18 rooms from 104's Python roogen generator compile into rooms that pass `checkRoo`.
- **3D preview input:** the client room built from a compiled file matches meridian-browser's `parseRoo` exactly (wall heights, bowties, separators, slope axes, node planes) on sampled shipped rooms.
- **Light sources:** which placed Kod objects give light and what light: class properties, `Create` arguments, objects created into a variable first, fixed `SendLightingInformation`, flickering ornaments, and lamps by the hour.
- **Game lighting:** the brightness curve, ambient, sun and shading at an hour, Kod constant expressions, and light settings inherited through parent classes.
- **Walk mode:** the walker moves exactly like Shards' `PlayerMover`, frame by frame, on sampled shipped rooms. In `edtest` it climbs the step and the ramp, and stops at the ledge, the pillar and the low tunnel.
- **Editor operations:** unit tests for each operation, plus drawing inner rooms and cutting lines in shipped rooms. Every fourth room by default; `ROO_STRESS=all` sweeps all 362. Every sector must stay closed.
- **Kod placements:** the parser on a sample class, and on the server's Kod tree when it's present: a class for nearly every shipped room, and the right one when several share a `.roo`.

### Screenshots

`npm run shots` takes the website's pictures of the editor and saves them to `screenshots/`. It uses the web build (`npm run editor:web`, started for you if it isn't running) at 1600×900, with the views listed in [`tools/screenshots/capture.ts`](tools/screenshots/capture.ts):

- Raza in split, map and 3D views;
- Raza at midnight with its lamps;
- walk mode;
- the Raza inn shaded by light, with the checks run.

`--only <name,...>` retakes some of them, and `--headed` shows the browser. The Meridian Shards website copies them with its `npm run images`.

`npm run shots:manual` takes the [user manual](docs/manual/README.md)'s pictures the same way, at 1440×900, into `docs/manual/images/`. The list is in [`tools/screenshots/manual.ts`](tools/screenshots/manual.ts): the window, dialogs and panels on the shipped rooms, and the tutorial room built step by step. If port 5174 is taken, `--port <n>` runs the editor's web build on another port.

## License

GPL-2.0-only. The compiler is a port of roomedit, which is GPL Meridian 59 code.
