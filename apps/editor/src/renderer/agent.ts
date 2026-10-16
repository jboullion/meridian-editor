// Answers calls from an agent (packages/agent, through agentEndpoint.ts): the
// editor's state, and the few things only the page can do. The agent does the
// room work itself with the same ops and sends back the result, which lands
// here as one undo step, labelled in the status bar.

import { formatRoomSource } from "@meridian-editor/roomc";
import type { AgentCall, AgentReply, AgentState } from "../main/agentProtocol.ts";
import { selectionCenter } from "./commands.tsx";
import { host } from "./host.ts";
import { currentKodRoom, kod, reloadKod } from "./kod/kodStore.ts";
import { preview3d } from "./preview/capture.ts";
import { clientToEditor, editorToClient, startWalk, stopWalk, walk } from "./preview/walkStore.ts";
import { edit, editor, isDirty, loadRoom, notify, redo, requestView, savePrefs, select, setMode, undo } from "./store.ts";
import { reloadLibrary } from "./textures/library.ts";

// Every change to the room bumps the revision the agent checks its edits against.
let revision = 0;
let lastRoom = editor.get().room;
editor.subscribe(() => {
  const room = editor.get().room;
  if (room !== lastRoom) {
    lastRoom = room;
    revision++;
  }
});

export async function handleAgentCall(call: AgentCall): Promise<AgentReply> {
  try {
    return { ok: true, value: await run(call) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

function state(): AgentState {
  const s = editor.get();
  const w = walk.get();
  const at = s.room && w.active ? clientToEditor(s.room.things, w.x, w.y) : null;
  return {
    roomsDir: "",
    path: null,
    docId: s.doc?.id ?? null,
    name: s.doc?.name ?? null,
    room: s.room,
    dirty: isDirty(s),
    revision,
    undoDepth: s.undo.length,
    redoDepth: s.redo.length,
    target: s.target,
    prefs: s.prefs,
    selection: s.selection,
    view: s.view,
    mode: s.mode,
    light: s.light,
    display: { grid: s.grid, snap: s.snap, showGrid: s.showGrid, colorBy: s.colorBy, ceilings: s.ceilings, kod: kod.get().show },
    walk: { active: w.active, at: at && [Math.round(at[0]), Math.round(at[1])], floor: Math.round(w.z / 16), angle: Math.round((((w.angle * 360) / 4096 + 90) % 360) * 10) / 10 },
    kodClass: currentKodRoom().room?.className ?? null,
  };
}

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

async function run(call: AgentCall): Promise<unknown> {
  switch (call.op) {
    case "state":
      return state();

    case "replace": {
      if (call.ifRevision !== revision) throw new Error(`The room changed in the editor while the agent worked on it (revision ${revision}, not ${call.ifRevision}). Nothing was applied; try again.`);
      if (!editor.get().room) throw new Error("No room is open in the editor.");
      edit(() => call.room);
      notify(`Agent: ${call.label}`);
      return { revision };
    }

    case "load":
      loadRoom({ id: call.id ?? null, name: call.name }, call.room, call.saved ? call.room : null);
      notify(`Agent opened ${call.name}`);
      return { revision };

    case "save": {
      const s = editor.get();
      if (!s.room || !s.doc) throw new Error("No room is open in the editor.");
      const id = call.id ?? s.doc.id;
      if (!id) throw new Error(`${s.doc.name} has never been saved: give a path in the rooms folder, such as new/${s.doc.name}.room.json.`);
      const room = s.room;
      await host.writeRoom(id, formatRoomSource(room));
      editor.set({ doc: { id, name: call.name ?? s.doc.name }, saved: room });
      notify(`Agent saved ${call.name ?? s.doc.name}`);
      return state();
    }

    case "undo":
    case "redo": {
      const before = editor.get().room;
      if (call.op === "undo") undo();
      else redo();
      const s = editor.get();
      return { changed: s.room !== before, revision, undoDepth: s.undo.length, redoDepth: s.redo.length };
    }

    case "target":
      editor.set({ target: call.target });
      return null;

    case "prefs": {
      const old = editor.get().prefs;
      savePrefs(call.prefs);
      if (call.prefs.texturesDir !== old.texturesDir) void reloadLibrary();
      if (call.prefs.kodDir !== old.kodDir) void reloadKod();
      return null;
    }

    case "select": {
      select(call.selection);
      const { room, selection } = editor.get();
      if (call.center && room && selection) {
        const c = selectionCenter(room, selection);
        if (c) requestView({ kind: "center", x: c[0], y: c[1] });
      }
      return { selection };
    }

    case "view":
      if (call.mode) setMode(call.mode);
      if (call.view) editor.set({ view: call.view });
      if (call.fit) requestView({ kind: "fit" });
      if (call.center) requestView({ kind: "center", x: call.center[0], y: call.center[1] });
      if (call.zoom) requestView({ kind: "zoom", factor: call.zoom });
      return null;

    case "light":
      editor.set((s) => ({ light: { ...s.light, ...call.light } }));
      return { light: editor.get().light };

    case "display": {
      const { kod: showKod, ...rest } = call.display;
      editor.set(rest);
      if (showKod !== undefined) kod.set({ show: showKod });
      return state().display;
    }

    case "notify":
      notify(call.text, call.kind);
      return null;

    case "walk": {
      if (call.action === "stop") {
        stopWalk();
        return null;
      }
      const room = editor.get().room;
      if (!room) throw new Error("No room is open in the editor.");
      const at = call.at ? editorToClient(room.things, call.at[0], call.at[1]) : null;
      startWalk(at ?? undefined);
      return null;
    }

    case "kodClass": {
      const name = editor.get().doc?.name;
      if (!name) throw new Error("No room is open in the editor.");
      kod.set((s) => ({ picked: { ...s.picked, [name]: call.className } }));
      return null;
    }

    case "render3d": {
      // The 3D view has to be showing to draw; show it while the picture is taken.
      const view = editor.get().view;
      if (view === "2d") editor.set({ view: "split" });
      try {
        for (let i = 0; !preview3d.capture && i < 100; i++) await new Promise((r) => setTimeout(r, 50));
        if (!preview3d.capture) throw new Error("The 3D view didn't open.");
        const shot = await preview3d.capture({ camera: call.camera, light: call.light, width: call.width, height: call.height });
        return { png: shot.url.replace(/^data:image\/png;base64,/, ""), width: shot.width, height: shot.height, notes: shot.notes };
      } finally {
        if (view === "2d") {
          await settle();
          editor.set({ view });
        }
      }
    }

    case "screenshot":
      throw new Error("The page can't take a screenshot of itself.");
  }
}
