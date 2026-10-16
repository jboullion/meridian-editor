# Working with an AI agent

An AI agent such as Claude Code can build and edit rooms with the editor's own operations. It can draw, run roomedit's operations, set any field, run the checks, walk the room the way the game does, and write a new room's Kod. It can work on room files by itself, or in the editor you have open, where you watch each change happen.

## Setting it up

The agent tools come with the editor's source, as an MCP server:

```bash
npm run mcp
```

Claude Code finds it by itself in the editor's repository (`.mcp.json`). Approve the `meridian-editor` server the first time it asks. Other MCP clients can run the same command.

## Working on files

On its own, the agent works on the files in the rooms folder. It keeps one room open, with its own undo history, and nothing in the editor changes until you open the room there. Ask it things like:
- "Make a new room called cellar: 12 by 10 squares, with a raised stone platform in the north-west corner and a ramp up to it."
- "Review src/raza and tell me what the checks find."
- "Find every wall using texture 4713 in tosinn and change it to 4610."

The agent can see the map: it draws pictures of it, with sectors and linedefs numbered, to check its work.

## Working in the editor with you

Ask the agent to connect to the editor, with "connect to the editor" or "work in the editor". From then on it works on the room open in the editor:
- **You see each change** as it happens. The status bar says what the agent did, such as *Agent: draw rectangle*.
- **Each step it takes is one undo step.** Ctrl+Z undoes it like any of your edits.
- **Your edits win.** If you change the room while the agent is working on it, its change is refused, and it reads the room again before trying again.
- It can **select things** to show you, change the view and lighting, start walk mode for you, and **take pictures of the 3D view** from anywhere at eye level, at any game hour. In the desktop app it can also take a screenshot of the window.

This works with the desktop app (`npm run editor`) and with the web build (`npm run editor:web`, with the page open). Ask it to disconnect to go back to files.

## Walk tests

The agent walks rooms with the client's own movement rules, the same ones walk mode uses. When something stops the player, it says which wall and why: a step over 24, a ceiling under 48, or a side that isn't passable. It can save a route as a walk test (`rooms/new/<room>.walk.json`).

## Kod

The agent reads the room's Kod class to see where its exits, monsters and objects are. For a **new** room, it can write the room's own class (`rooms/new/<room>.kod`): the arrival square, exits, objects such as braziers and signs, and the light. It never changes the server's Kod.

## Testing on the local Shards server

The agent can put a new room on your local Shards server and walk it there with a test account, as `npm run shards:install` and `npm run shards:walk` do:
- **Installing asks you first, every time.** It reloads the server's Kod, which saves the game.
- **Walking uses only the `shardpal` account**, and not while anyone is logged in as it.

## Ready-made requests

MCP clients that show prompts list three:
- **Build a room**: from a name and a description.
- **Review a room**: checks, compiling, walking and Kod placements, reported without changing anything.
- **Import a compiled room**: a `.roo` as a source, checked to recompile the same.

---

Previous: [Checks and export](11-checks-and-export.md) · Next: [Keyboard shortcuts](keyboard-shortcuts.md)
