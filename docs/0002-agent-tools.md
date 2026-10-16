# ADR 0002: Agent tools over MCP, on files or in the running editor

- Status: Accepted
- Date: 2026-10-13

## Context

We want AI agents (Claude Code and other MCP clients) to work on rooms the way a person does in the editor. That means drawing, every roomedit operation, every inspector field, checks, the 3D view, walking the room, the room's Kod, and testing in Shards. Agents should also be able to work beside the user, in the window the user is looking at.

What the editor already has:
- **The room logic is pure TypeScript.** `src/renderer/ops`, `kod/kodRooms.ts`, `kodLights.ts`, `kodChecks.ts`, `preview/walker.ts`, `clientRoom.ts` and `geometry.ts` import only `roo`, `roomc` and each other, so Node can run them (`tools/shards/make-edtest.ts` already does).
- **The UI is mostly dialogs.** Many of the commands in `commands.tsx` open one, which an agent can't answer.

## Decision

1. **One MCP server, `packages/agent`, over stdio**, registered for Claude Code in `.mcp.json`.
   - Its tools call the editor's pure functions with arguments, never the commands.
   - `coverage.ts` maps every command to the tools that do it, or says why there are none, and a test fails when a command has no entry.
2. **Two backends behind one `Session` interface.**
   - *Headless* (`HeadlessSession`): one room in memory, with its own undo history, read from and written to the rooms folder. Nothing needs to be running.
   - *Live* (`LiveSession`, after `connect_editor`): the room open in the editor.
3. **In live mode, the room logic stays in the agent.**
   - Before each tool call, the agent reads the editor's state (`AgentState`). The tool runs as it would headless. After the call, the changed room goes back in one `replace` call: one undo step, labelled "Agent: …" in the status bar.
   - The page only reports state, takes rooms back, and does what only it can do: select, view, light, walk, render the 3D view.
   - We considered running the tools in the page, but that would put zod, the MCP schemas and every handler into the renderer for little gain.
4. **Revisions guard indices.**
   - Items are addressed by array index, which shifts when an earlier item is deleted. Every result carries the room's revision, and edits take `ifRevision`.
   - In live mode, `replace` carries the revision the agent read, and the page refuses it if the user has edited since. The user's edit wins, and the agent reads again.
5. **The live link** is a small HTTP endpoint on 127.0.0.1 (`agentEndpoint.ts`), served by the Electron main process and by the Vite dev server for the web build.
   - Its address and a random token go in `agent.json` (or `agent-web.json`) in the editor's data folder. Requests need the token, and requests from web pages (with an `Origin` header) are refused.
   - Electron passes calls to the page over IPC; the dev server passes them over its HMR socket.
   - The endpoint turns file ids into paths: Electron's page uses absolute paths, the web build's uses paths in the rooms folder.
6. **Pictures are made where they can be.**
   - `render_map` draws the map in Node (a small rasterizer and PNG encoder, so no native dependencies) and works in both modes.
   - `render_3d` asks the page's 3D preview for one frame from any camera, and needs the editor. `screenshot_window` needs the desktop app.
7. **Writing outside the room is fenced.**
   - Kod writers touch only `rooms/new/<room>.kod`; the server's Kod stays read-only.
   - `shards_install` needs `confirmed: true` on every call, since it reloads the server's Kod, which saves the game.
   - `shards_walk` logs in only as `shardpal`, and only when `who` shows it isn't online.

## Consequences

- One set of tools works with or without the app. Tests run the headless backend, and a stand-in page for the live one.
- Rebuilding `edtest` through the tools gives `make-edtest.ts`'s output byte for byte, so the tools are the editor's operations, not look-alikes.
- In live mode, each tool call sends the whole room to the agent and back. That's fine on localhost even for the biggest shipped rooms, but it isn't a protocol for remote use.
- Undo labels exist only in the status bar: the editor's undo stack doesn't store them.
- The editor itself still reads Kod only from the server's tree, so a new room's own Kod shows in the agent's tools before it shows on the editor's map.
