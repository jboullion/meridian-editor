# ADR 0001: A room editor, with text room sources compiled to `.roo`

- Status: Accepted
- Date: 2026-10-11

## Context

Shards needs new rooms, and making them is hard today. Shards runs an **unmodified Server 104** (`meridian-browser/server/src`), so its rooms are ROO v15.

Below, two read-only trees in `meridian-unreal/ReferenceServers` are cited by prefix:
- `o:` is the original server, `MeridianSteam/Meridian59`.
- `s:` is Server 104, `Server-104`.

**The existing editor:** both trees ship `roomedit/`, which is WinDEU 5.24, a Doom map editor on OWLNext. The root makefile builds it (`o:makefile:11,97`), and a prebuilt `roomedit/roomedit.exe` is checked in.
- It opens and saves `.roo` directly, with no source format in between (`roomedit/source/load.cpp:272`, `save.cpp:527`).
- On save, it builds the BSP (`source/bspmake.cpp:1057`). The original tree also bakes the server's movement and flag grids (`o:roomedit/source/move.cpp:58,274`).
- It is a 1990s Windows UI that the team doesn't want to build on.

**The `.roo` layout is fully known.** Three readers agree on it: the editor (`roomedit/source/load.cpp`, `save.cpp`), the client (`clientd3d/bspload.c`) and the server (`blakserv/roofile.c`).
- **Header:** the magic `52 4F 4F B1`, then int32 version, security, main offset and server offset.
- **Main section:** int32 width and height, then six offsets. The sections that follow are BSP nodes, client walls, editor walls, sidedefs, sectors (each with optional 46-byte slope records), things, and an int32 RoomID.
- **Server section:** the original stores three movement grids here. 104 stores nothing.
- **The security checksum:** a running int32 sum over the version, BSP, walls, sidedefs and sectors, XORed with `0x89ab786c` (`o:roomedit/source/save.cpp:714`, `s:save.cpp:894`).
  - Kod passes the stored value to the client (`kod/object/active/holder/room.kod:1084`, `user.kod:2466`).
- **Second reference:** `s:roomedit/roogen/roofile.py` is a v15 reader and writer. It claims byte-for-byte round-trips of the 362 shipped 104 rooms.

**Props, monsters, exits and triggers are not in the `.roo`.** Kod places them as row/col values:
- `plExits` (`kod/object/active/holder/room/barlqrm/barapoth.kod:54`)
- `plGenerators` (`kod/object/active/holder/room/monsroom/g9.kod:169`)
- `NewHold #new_row/#new_col`

Kod animates sectors and walls by `server_id` through `SetSector`, `SetSectorLight`, `AnimateWall` and `ChangeTexture` (`room.kod:2477-2601`).

**Things are only the room's bounds.** The first two things are the corners of the room box (`roomedit/source/load.cpp:625`). That box sets the width, height and grids, and it fixes the Kod row/col mapping (`load.cpp:645-665`).
- **Original:** neither the client nor the server reads things. The server discards the offset (`o:blakserv/roofile.c:258`).
- **104:** the client and the server **reject any count other than 2** (`s:clientd3d/bspload.c:151`, `s:blakserv/roofile.c:1690`). They take the room's bounds, rows and columns from those two things (`s:bspload.c:724-737`, `s:roofile.c:1715-1734`).
- **More than 2 things:** roomedit switches to a 96-byte thing record. Such a room saves, but 104 won't load it.

**The original and 104 use two formats from one ancestor.** Both began at v12, with integer coordinates. Each project moved to floats separately: the original calls the result v13, and 104 calls it v14, then v15.

| | Original | Server 104 (Shards) |
|---|---|---|
| Shipped rooms | 122 × v12, 143 × v13 (`o:resource/rooms`) | 362 × v15 in `s:resource/rooms`; 400 in the tree, all v15 |
| Editor writes | v13 (`o:roomedit/include/levels.h:47`) | v15 (`s:roomedit/include/levels.h:47`) |
| Version check | client ≥ 10 (`o:clientd3d/bspload.c:78`), server ≥ 4 (`o:blakserv/roofile.c:221`) | client and server ≥ 14 (`s:bspload.c:67`, `s:roofile.c:1322`) |
| Checksum | includes the float bits of planes, leaf points and wall ends (`o:save.cpp:59,124-130`) | leaves them out, and adds heights as unsigned (`s:save.cpp:114-123,165-169,297-319`) |
| Checksum enforced | the client rejects a mismatch (`o:bspload.c:222`) | only when `config.security` is set (`s:bspload.c:182`) |
| Slope texture origin | f32 | i32 |
| Server section | three movement grids | empty; its offset points at end of file (`s:save.cpp:887,891`). The server does geometric collision from the BSP (`s:roofile.c:719`), but only for monsters and server moves |
| Extra wall flags | `WF_NO_HTILE`, 2-bit translucency | none; sidedef flags use bits 0–14 only |

- **v14 and v15:** they are byte-identical. Only the version number feeds into the checksum.
- **BSP builders:** the two differ only in casts and printf formats.
- **Compatibility:** neither client accepts the other's files.

**In 104 the client enforces walls, steps and ceilings for players.** Kod skips the BSP check for player moves, which "have already been checked by client" (`s:kod/object/active/holder/room.kod:2372`). `UserMove` only puts a player back when the spot is outside every sector (`s:kod/.../player/user.kod UserMove`). So whether a room is walkable is decided by the client's `move.c`, which Shards ports (meridian-browser `packages/world/src/movement.ts`):
- A wall side without `WF_PASSABLE` is solid.
- A step up of more than 24 is blocked, but only where the side has a below texture.
- Headroom under 48 is blocked, but only where the side has an above texture.

So a step or a low ceiling with an untextured face can be walked straight through.

**104 details the compiler must keep:**
- **Unknown sector flag:** `0x2000` is undefined, but it is set on 3,952 shipped sectors. roomedit keeps it, so we must too.
- **Unsigned heights:** the 104 server and checksum read floor and ceiling heights as unsigned (`s:roofile.c:1599-1604`). A negative height loads wrong.

**Rule conflict:** the art rule bans committing `.roo` files. A binary-only editor would leave rooms we author nowhere to live.

## Decision

1. **Build a new room editor in this repo, `meridian-editor`**, under GPL-2.0, in TypeScript with Electron, React and three.js.
   - It is a separate product, with a separate release cycle.
   - It serves Shards (Server 104) and the original server.
2. **The working file is a text room source (JSON); `.roo` is a build output.** A headless compiler, `roomc`, turns a source into a `.roo`:
   - `roomc compile <src.room.json> --target original|104 -o <out.roo>`
   - `roomc import <in.roo> -o <src.room.json>`, which reads v12 to v15
   - `roomc verify <out.roo> [--target original|104]`
3. **Two target profiles:**
   - `104` for Shards and Server 104: v15, the 104 checksum, an i32 slope origin, an empty server section, and exactly two things.
   - `original` for the original server: v13, the original checksum, an f32 slope origin, the three server grids, and the extra wall flags.

   The profile chooses the version, the checksum rule, the slope encoding, whether grids are written and which flags are allowed. The validator flags anything the target can't store. Moving a room to the other server means compiling it for the other target.
4. **Port the compiler from `roomedit/` line by line:** BSP (`bspmake.cpp`), grids (`o:move.cpp`), slopes and the checksum (`save.cpp`). Don't redesign it.
   - Every stored float goes through `Math.fround` and a `DataView`, so the sums match C `float`.
   - Byte-for-byte output is the test. v12 rooms can't match, because we write v13; byte tests use the 143 v13 rooms and the 104 v15 rooms.
   - **Result:** import → compile reproduces all 143 original v13 rooms, grids included, and all 381 roomedit-made 104 rooms.
   - **Shipped 104 rooms come from several roomedit builds.** Import detects three older quirks and records them as `compat` flags in the source:
     - In 114 rooms, a missing back side's editor-wall offsets repeat the front side's.
     - In 32 rooms, BSP flips leave the y offsets in place.
     - In 54 rooms, slope planes were computed in float.
   - **Exceptions:**
     - `d6e6ulake.roo` stores two slope planes that don't pass through their own points; we write the correct plane.
     - roogen's 18 generated rooms come from its own Python BSP builder, so they aren't byte targets.
5. **Kod stays the home of placements.** The editor shows `plExits`, `plGenerators` and `NewHold` from the room's `.kod` as a read-only overlay, and gives Kod snippets to paste.
   - 104's old `SaveKodFiles` (`s:roomedit/source/save.cpp:549-698`, disabled in 2004) is the reference for the row, col, fine and angle mapping.
   - Editor-generated Kod files need their own ADR.
6. **Sources for rooms we author are committed in the Shards repo (meridian-browser); compiled `.roo` files are not.** Its asset build (`tools/assets/build-assets.ts`) runs `roomc`, and the rooms are served like other art.
   - The `rooms/src/` layout and the build step are decided when the first Shards room exists.
   - 104's shipped `.roo` files stay as they are. Imported rooms are committed as sources only once we change them.
   - Changed 2026-10-15: Shards' server is now our fork, the shards-server repository. Every room's source is committed there, in `resource/rooms/src/` (all 357 that recompile byte for byte), with the compiled `.roo` beside it in `resource/rooms/`, which the server build already copies. Saving or installing a room writes both; a test checks they match. No `roomc` step in meridian-browser's asset build is needed: it copies the server's rooms.

## Consequences

- **No C or Kod changes:** the `104` output is plain v15, which 104's unmodified client and server accept.
- **Shared reader:** meridian-browser's `roo.ts` reads v14+ only, skips the editor section and has no writer. Our reader could replace it later; both are GPL.
- **What the editor can reuse from meridian-browser:**
  - `parseBgf` (`packages/formats/src/bgf.ts:44`)
  - `buildRoomGeometry` (`packages/render/src/roomGeometry.ts:76`)
  - `RoomView` (`packages/render/src/roomView.ts:59`)
- **meridian-unreal can't share code:** it bans copying or translating GPL code (its `AGENTS.md` and `docs/research/roo-format.md`). It only consumes the compiled `.roo` files.
- **Moving the corner things shifts every Kod row/col** in the room. The editor shows the room's Kod placements on the map, and its Kod check flags any that end up outside the room box or where there is no floor.
- **Testing in the game:** `tools/shards` puts a room on the local Shards server and walks it.
  - `npm run shards:install -- <room>` compiles `rooms/new/<room>.room.json` and copies the `.roo` to the server and the client assets. For a new room it also builds and loads its `.kod`.
  - `npm run shards:walk -- <room>` logs in a test account through the gateway, has the server teleport it into the room, and checks the checksum.
  - It then walks a scripted route with Shards' own client movement code (`rooms/new/<room>.walk.json`), so steps, ramps and solid walls are tested the way players meet them.
  - `rooms/new/edtest` is the first room made this way: RID 4200, 19 of 19 checks pass.
- **roomedit's defaults make rooms you can't walk in.** It creates linedefs without `WF_PASSABLE`, so a drawn platform's edge is a solid wall in 104. The editor sets the flag on walls that drawing makes two-sided (a Preference, on by default).
- **Cost:** the format work is bounded, maybe weeks. A good 2D/3D editing experience is most of the effort, maybe months part-time.
- **Follow-ups in meridian-browser:** an `AGENTS.md` line and a build step for room sources, when the first source lands.

## Alternatives

- **Keep using `roomedit.exe`:** rejected as the long-term tool. It is Windows-only and binary-only, with a dated UI. It stays the reference for verifying our compiler.
- **Edit `.roo` directly, like roomedit:** rejected. It means binary diffs, no merges, and new rooms can't be committed under the art rule.
- **Put the editor in the meridian-browser monorepo:** rejected. That would make reuse easier, but it would tie the editor's releases to the client's.
- **Compile roomedit's C++ to WASM:** rejected. It needs an Emscripten toolchain and keeps the OWL-era globals; a TS port is testable in Node and runs in a worker.
- **Store placements in the `.roo` things:** rejected. The original server ignores things, and 104 rejects any room without exactly two. Kod would still need the values.
