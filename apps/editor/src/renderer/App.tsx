import { useEffect, useMemo, useState } from "react";
import { PROFILES, type TargetName } from "@meridian-editor/roo";
import { openEntry, openFromSystem } from "./actions.ts";
import { handleAgentCall } from "./agent.ts";
import { handleKey, runCommand, selectionCenter } from "./commands.tsx";
import { useAutoCompile, useCompiled } from "./compiler.ts";
import { CommandPalette, ContextMenu } from "./ContextMenu.tsx";
import { DialogHost } from "./dialogs.tsx";
import { kodCoords } from "./geometry.ts";
import { host, type RoomEntry } from "./host.ts";
import { Inspector } from "./Inspector.tsx";
import { MapView } from "./MapView.tsx";
import { PreviewView } from "./PreviewView.tsx";
import { edit, editor, isDirty, notify, requestView, selectOne, useCursor, useEditor, type ItemKind, type Tool, type ViewMode } from "./store.ts";
import { reloadLibrary } from "./textures/library.ts";
import { KodPanel } from "./kod/KodPanel.tsx";
import { kodMarks, reloadKod, roomBox, useKod, useKodRoom } from "./kod/kodStore.ts";
import { useWalk } from "./preview/walkStore.ts";

/** Game hours for the lighting menu: what the server's sun and brightness do at each (gameLight.ts). */
const HOURS = Array.from({ length: 24 }, (_, hour) => ({
  hour,
  label: `${String(hour).padStart(2, "0")}:00${hour === 13 ? " · midday" : hour === 1 ? " · night" : hour === 7 ? " · dawn" : hour === 19 ? " · dusk" : ""}`,
}));

export function App(): React.JSX.Element {
  useAutoCompile();
  const view = useEditor((s) => s.view);
  const doc = useEditor((s) => s.doc);
  const dirty = useEditor(isDirty);
  const hasRoom = useEditor((s) => s.room !== null);

  useEffect(() => {
    const title = doc ? `${dirty ? "● " : ""}${doc.name} — Meridian Room Editor` : "Meridian Room Editor";
    host.setTitle(title);
    host.setDirty(dirty);
  }, [doc, dirty]);

  useEffect(() => {
    void reloadLibrary();
    void reloadKod();
    const offMenu = host.onMenu((command) => runCommand(command));
    const offOpen = host.onOpenFile((file) => openFromSystem(file));
    const offAgent = host.onAgentCall(handleAgentCall);
    const offUpdate = host.onUpdate((u) => {
      if (u.state === "ready") notify(`Version ${u.version} is ready: it installs when you quit, or now from Help → Restart to update.`);
      else if (u.state === "available") notify(`Version ${u.version} is out: Help → Check for updates opens its download page.`);
    });
    const onKey = (e: KeyboardEvent): void => void handleKey(e);
    window.addEventListener("keydown", onKey);
    const beforeUnload = (e: BeforeUnloadEvent): void => {
      if (host.kind === "browser" && isDirty(editor.get())) e.preventDefault();
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => {
      offMenu();
      offOpen();
      offAgent();
      offUpdate();
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("beforeunload", beforeUnload);
    };
  }, []);

  return (
    <div className="app">
      <Toolbar />
      <div className="workspace">
        <RoomList />
        <main className={`views views-${view}`}>
          {!hasRoom && <Welcome />}
          {hasRoom && view !== "3d" && (
            <div className="view-pane">
              <MapView />
              <ToolHint />
            </div>
          )}
          {hasRoom && view !== "2d" && (
            <div className="view-pane">
              <PreviewView />
            </div>
          )}
        </main>
        <aside className="sidebar right">
          <Inspector />
        </aside>
      </div>
      <BottomPanel />
      <StatusBar />
      <ContextMenu />
      <CommandPalette />
      <DialogHost />
    </div>
  );
}

const MODES: { value: ItemKind; label: string; key: string }[] = [
  { value: "thing", label: "Things", key: "T" },
  { value: "vertex", label: "Vertices", key: "V" },
  { value: "linedef", label: "Linedefs", key: "L" },
  { value: "sector", label: "Sectors", key: "S" },
];

const TOOLS: { value: Tool; label: string; icon: string; key: string }[] = [
  { value: "select", label: "Select", icon: "⬚", key: "Q" },
  { value: "draw", label: "Draw lines", icon: "✎", key: "D" },
  { value: "rectangle", label: "Rectangle", icon: "▭", key: "R" },
  { value: "polygon", label: "Polygon", icon: "⬡", key: "4" },
  { value: "circle", label: "Circle", icon: "◯", key: "5" },
  { value: "torch", label: "Torch", icon: "🔥", key: "6" },
  { value: "thing", label: "Thing", icon: "●", key: "7" },
];

function Toolbar(): React.JSX.Element {
  const target = useEditor((s) => s.target);
  const view = useEditor((s) => s.view);
  const mode = useEditor((s) => s.mode);
  const tool = useEditor((s) => s.tool);
  const grid = useEditor((s) => s.grid);
  const snap = useEditor((s) => s.snap);
  const colorBy = useEditor((s) => s.colorBy);
  const ceilings = useEditor((s) => s.ceilings);
  const walking = useWalk((s) => s.active);
  const light = useEditor((s) => s.light);
  const canUndo = useEditor((s) => s.undo.length > 0);
  const canRedo = useEditor((s) => s.redo.length > 0);
  const hasRoom = useEditor((s) => s.room !== null);
  const dirty = useEditor(isDirty);
  const views: { value: ViewMode; label: string }[] = [
    { value: "2d", label: "Map" },
    { value: "split", label: "Split" },
    { value: "3d", label: "3D" },
  ];
  return (
    <header className="toolbar">
      <div className="toolbar-row">
        <div className="brand">Meridian Room Editor</div>
        <div className="group">
          <button onClick={() => runCommand("file.new")} title="New room (Ctrl+N)">
            New
          </button>
          <button onClick={() => runCommand("file.open")} title="Open a .room.json or import a .roo (Ctrl+O)">
            Open
          </button>
          <button onClick={() => runCommand("file.save")} disabled={!hasRoom} title="Save the room source (Ctrl+S)">
            Save{dirty ? " •" : ""}
          </button>
          <button onClick={() => runCommand("file.export")} disabled={!hasRoom} className="primary" title="Compile for the target and save the .roo (Ctrl+E)">
            Export .roo
          </button>
        </div>
        <div className="group">
          <label className="inline">
            Target
            <select value={target} onChange={(e) => editor.set({ target: e.target.value as TargetName })} title={PROFILES[target].description}>
              <option value="104">104 (Shards)</option>
              <option value="original">Original</option>
            </select>
          </label>
        </div>
        <div className="group">
          <button onClick={() => runCommand("edit.undo")} disabled={!canUndo} title="Undo (Ctrl+Z)">
            Undo
          </button>
          <button onClick={() => runCommand("edit.redo")} disabled={!canRedo} title="Redo (Ctrl+Y)">
            Redo
          </button>
        </div>
        <div className="group">
          <button onClick={() => runCommand("check.all")} disabled={!hasRoom} title="Run roomedit's checks (F9)">
            Check
          </button>
          <button onClick={() => runCommand("textures.browse")} title="Browse textures">
            Textures
          </button>
          <button onClick={() => runCommand("view.palette")} title="All commands (Ctrl+Shift+P)">
            ⌘ Commands
          </button>
        </div>
        <CompileChip />
      </div>
      <div className="toolbar-row">
        <div className="group segmented" role="group" aria-label="Mode">
          {MODES.map((m) => (
            <button key={m.value} className={mode === m.value ? "active" : ""} onClick={() => runCommand(`mode.${m.value}`)} title={`${m.label} mode (${m.key})`}>
              {m.label}
            </button>
          ))}
        </div>
        <div className="group segmented tools" role="group" aria-label="Tool">
          {TOOLS.map((t) => (
            <button key={t.value} className={tool === t.value ? "active" : ""} onClick={() => runCommand(`tool.${t.value}`)} disabled={!hasRoom} title={`${t.label} (${t.key})`}>
              <span aria-hidden="true">{t.icon}</span> {t.label}
            </button>
          ))}
        </div>
        <div className="group segmented" role="group" aria-label="View">
          {views.map((v) => (
            <button key={v.value} className={view === v.value ? "active" : ""} onClick={() => editor.set({ view: v.value })}>
              {v.label}
            </button>
          ))}
        </div>
        <div className="group">
          <label className="inline" title="Snap to the grid (Shift+H)">
            <input type="checkbox" checked={snap} onChange={(e) => editor.set({ snap: e.target.checked })} />
            Snap
          </label>
          <select value={grid} onChange={(e) => editor.set({ grid: Number(e.target.value) })} title="Grid size in editor units; 64 = one Kod square (G / Shift+G)">
            {[1, 2, 4, 8, 16, 32, 64, 128, 256].map((g) => (
              <option key={g} value={g}>
                grid {g}
              </option>
            ))}
          </select>
          <select value={colorBy} onChange={(e) => editor.set({ colorBy: e.target.value as "floor" | "light" | "ceiling" })} title="Shade sectors by">
            <option value="floor">Floor height</option>
            <option value="ceiling">Ceiling height</option>
            <option value="light">Light</option>
          </select>
          <select
            value={light.mode === "flat" ? "flat" : String(light.hour)}
            onChange={(e) =>
              editor.set((s) => ({ light: e.target.value === "flat" ? { ...s.light, mode: "flat" } : { ...s.light, mode: "game", hour: Number(e.target.value) } }))
            }
            title="3D lighting: the client's, with the room's Kod light at a game hour, or each sector's light level (flat). More in View → Lighting…"
          >
            <option value="flat">Flat light</option>
            {HOURS.map((h) => (
              <option key={h.hour} value={h.hour}>
                {h.label}
              </option>
            ))}
          </select>
          <label className="inline" title="Show ceilings in the 3D preview">
            <input type="checkbox" checked={ceilings} onChange={(e) => editor.set({ ceilings: e.target.checked })} />
            Ceilings
          </label>
          <button onClick={() => requestView({ kind: "fit" })} disabled={!hasRoom} title="Fit the room in view (F)">
            Fit
          </button>
          <button
            className={walking ? "walk-button on" : "walk-button"}
            onClick={() => runCommand("view.walk")}
            disabled={!hasRoom}
            title="Walk the room at a player's eye height, as the client moves you (Shift+W). Right-click the map to walk from a spot."
          >
            Walk
          </button>
        </div>
      </div>
    </header>
  );
}

function ToolHint(): React.JSX.Element | null {
  const tool = useEditor((s) => s.tool);
  const prefs = useEditor((s) => s.prefs);
  const hints: Record<Tool, string> = {
    select: "",
    draw: "Click to place points. Click the first point to close a sector; double-click or Enter to finish a line; Backspace undoes a point; Esc cancels.",
    rectangle: `Drag out a rectangle. ${prefs.pillar ? "Inside a sector it becomes a pillar." : "Inside a sector it becomes an inner sector."}`,
    polygon: `Drag from the centre: a ${prefs.polygonSides}-sided polygon (Preferences sets the sides).`,
    circle: "Drag from the centre; more sides the bigger it is (roomedit's circle).",
    torch: `Click near a wall to place a torch facing ${["north", "east", "south", "west"][Math.trunc(prefs.torchAngle / 90)] ?? "north"} (Preferences).`,
    thing: "Click to add a thing. Server 104 only loads rooms with exactly two (the room box).",
  };
  if (tool === "select") return null;
  return <div className="tool-hint">{hints[tool]}</div>;
}

function CompileChip(): React.JSX.Element | null {
  const busy = useCompiled((s) => s.busy);
  const ok = useCompiled((s) => s.ok);
  const ms = useCompiled((s) => s.ms);
  const errors = useCompiled((s) => s.diagnostics.filter((d) => d.severity === "error").length);
  const warnings = useCompiled((s) => s.diagnostics.filter((d) => d.severity === "warning").length);
  const hasRoom = useEditor((s) => s.room !== null);
  if (!hasRoom) return null;
  const label = busy ? "Compiling…" : ok ? `Compiles · ${Math.round(ms)} ms` : `${errors} error${errors === 1 ? "" : "s"}`;
  return (
    <div className={`chip ${busy ? "busy" : ok ? "ok" : "bad"}`} title="The room recompiles for the target after every change">
      {label}
      {!busy && warnings > 0 && <span className="chip-warn"> · {warnings} warning{warnings === 1 ? "" : "s"}</span>}
    </div>
  );
}

function RoomList(): React.JSX.Element {
  const [rooms, setRooms] = useState<RoomEntry[]>([]);
  const [dir, setDir] = useState("");
  const [filter, setFilter] = useState("");
  const current = useEditor((s) => s.doc?.id);

  useEffect(() => {
    const load = (): void => {
      void host.listRooms().then(async (list) => {
        setRooms(list);
        setDir(await host.roomsDir());
      });
    };
    load();
    window.addEventListener("rooms-changed", load);
    return () => window.removeEventListener("rooms-changed", load);
  }, []);

  const shown = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return f ? rooms.filter((r) => r.path.toLowerCase().includes(f)) : rooms;
  }, [rooms, filter]);

  return (
    <aside className="sidebar left">
      <div className="room-list-head">
        <input type="search" placeholder={`Filter ${rooms.length} rooms`} value={filter} onChange={(e) => setFilter(e.target.value)} />
        {host.kind === "electron" && (
          <button className="small" onClick={() => runCommand("file.openFolder")} title="Choose the rooms folder">
            Folder…
          </button>
        )}
      </div>
      <div className="room-dir" title={dir}>
        {dir || "No rooms folder"}
      </div>
      <ul className="room-list">
        {shown.map((r) => (
          <li key={r.id}>
            <button className={r.id === current ? "active" : ""} onClick={() => void openEntry(r)} title={r.path}>
              {r.path.replace(/\.room\.json$/, "")}
            </button>
          </li>
        ))}
        {rooms.length === 0 && <li className="hint pad">No .room.json files found. Use Open to import a .roo, or New to start one.</li>}
      </ul>
    </aside>
  );
}

function Welcome(): React.JSX.Element {
  return (
    <div className="welcome">
      <h1>Meridian Room Editor</h1>
      <p>
        Pick a room on the left, open a <code>.room.json</code> source or a <code>.roo</code> to import, or start a new room.
      </p>
      <p className="hint">Rooms compile to ROO v15 for Server 104 (Shards) or v13 for the original server.</p>
      <div className="group" style={{ justifyContent: "center" }}>
        <button className="primary" onClick={() => runCommand("file.new")}>
          New room…
        </button>
        <button onClick={() => runCommand("file.open")}>Open…</button>
      </div>
    </div>
  );
}

function BottomPanel(): React.JSX.Element | null {
  const diagnostics = useCompiled((s) => s.diagnostics);
  const issues = useEditor((s) => s.issues);
  const [tab, setTab] = useState<"problems" | "checks" | "kod">("problems");
  const kodRoom = useKodRoom().room;
  const kodError = useKod((s) => s.error);
  const [open, setOpen] = useState(true);
  const [shownIssues, setShownIssues] = useState(issues);
  // A new check run brings its results to the front.
  if (issues !== shownIssues) {
    setShownIssues(issues);
    if (issues) {
      setTab("checks");
      setOpen(true);
    }
  }
  if (diagnostics.length === 0 && !issues && !kodRoom) return null;
  const errors = diagnostics.filter((d) => d.severity === "error").length;
  return (
    <section className={`bottom-panel ${open ? "open" : ""}`}>
      <div className="tabs">
        <button className="diag-toggle" onClick={() => setOpen((o) => !o)} aria-label={open ? "Collapse" : "Expand"}>
          {open ? "▾" : "▸"}
        </button>
        <button className={tab === "problems" ? "active" : ""} onClick={() => (setTab("problems"), setOpen(true))}>
          Compile · {errors} error{errors === 1 ? "" : "s"}, {diagnostics.length - errors} warning{diagnostics.length - errors === 1 ? "" : "s"}
        </button>
        {issues && (
          <button className={tab === "checks" ? "active" : ""} onClick={() => (setTab("checks"), setOpen(true))}>
            {issues.title} · {issues.items.length}
          </button>
        )}
        <button className={tab === "kod" ? "active" : ""} onClick={() => (setTab("kod"), setOpen(true))} title={kodError ?? undefined}>
          Kod{kodRoom ? ` · ${kodRoom.className}` : " · none"}
        </button>
        {issues && tab === "checks" && (
          <button className="small" onClick={() => editor.set({ issues: null })}>
            Clear
          </button>
        )}
      </div>
      {open && tab === "problems" && (
        <ul>
          {diagnostics.slice(0, 300).map((d, i) => (
            <li key={i} className={d.severity}>
              <span className="sev">{d.severity}</span> {d.message}
            </li>
          ))}
        </ul>
      )}
      {open && tab === "checks" && issues && (
        <ul>
          {issues.items.length === 0 && <li className="hint">No problems found.</li>}
          {issues.items.slice(0, 500).map((d, i) => (
            <li key={i} className={d.severity}>
              <span className="sev">{d.severity}</span>{" "}
              {d.item ? (
                <button
                  className="link"
                  onClick={() => {
                    selectOne(d.item!);
                    const room = editor.get().room;
                    const c = room && selectionCenter(room, { kind: d.item!.kind, indices: [d.item!.index] });
                    if (c) requestView({ kind: "center", x: c[0], y: c[1] });
                  }}
                >
                  {d.message}
                </button>
              ) : d.at ? (
                <button className="link" onClick={() => requestView({ kind: "center", x: d.at![0], y: d.at![1] })}>
                  {d.message}
                </button>
              ) : (
                d.message
              )}
              {d.fix && (
                <button
                  className="small"
                  onClick={() => {
                    const fix = d.fix!;
                    if (edit((room) => fix.apply(room))) editor.set({ issues: { title: issues.title, items: issues.items.filter((x) => x !== d) } });
                  }}
                >
                  {d.fix.label}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {open && tab === "kod" && <KodPanel />}
    </section>
  );
}

function StatusBar(): React.JSX.Element {
  const c = useCursor();
  const room = useEditor((s) => s.room);
  const message = useEditor((s) => s.message);
  const selection = useEditor((s) => s.selection);
  const mode = useEditor((s) => s.mode);
  const tool = useEditor((s) => s.tool);
  const kod = room && c.inside ? kodCoords(room, c.x, c.y) : null;
  const kodRoom = useKodRoom().room;
  const showKod = useKod((s) => s.show);
  const box = room && roomBox(room.things);
  // What the room's Kod puts on the square under the cursor.
  const here = kod && kodRoom && box && showKod ? kodMarks(kodRoom, box).filter((m) => m.row === kod.row && m.col === kod.col) : [];
  return (
    <footer className="statusbar">
      <span className={message?.kind === "error" ? "status-error" : ""}>{message?.text ?? "Ready"}</span>
      <span className="spacer" />
      <span>
        {mode} mode · {tool}
      </span>
      {selection && (
        <span>
          {selection.indices.length === 1 ? `${selection.kind} ${selection.indices[0]}` : `${selection.indices.length} ${selection.kind}s`}
        </span>
      )}
      {c.inside && (
        <span>
          x {Math.round(c.x)}, y {Math.round(c.y)}
          {kod && ` · Kod row ${kod.row}, col ${kod.col}`}
        </span>
      )}
      {here.length > 0 && (
        <span className="kod-here" title={here.map((m) => `${m.label} (${kodRoom!.path}:${m.line})`).join("\n")}>
          {here.map((m) => m.label).slice(0, 3).join(" · ")}
          {here.length > 3 && ` +${here.length - 3}`}
        </span>
      )}
    </footer>
  );
}
