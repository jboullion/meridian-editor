// The map's right-click menu (roomedit's per-mode popup menus) and the
// command palette (every command, searchable).

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { COMMANDS, palette, runCommand, type Command, type Group } from "./commands.tsx";
import { editor, Store, useEditor, type ItemKind } from "./store.ts";

const menu = new Store<{ at: { x: number; y: number } | null }>({ at: null });

export function openContextMenu(x: number, y: number): void {
  menu.set({ at: { x, y } });
}

const MODE_GROUP: Record<ItemKind, Group> = { vertex: "Vertices", linedef: "Linedefs", sector: "Sectors", thing: "Things" };

export function ContextMenu(): React.JSX.Element | null {
  const at = useSyncExternalStore(menu.subscribe, () => menu.get().at);
  const mode = useEditor((s) => s.mode);
  const state = useEditor((s) => s);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const [placed, setPlaced] = useState<typeof at>(null);

  useEffect(() => {
    if (!at) return;
    const close = (e: Event): void => {
      if (e instanceof KeyboardEvent && e.key !== "Escape") return;
      if (e instanceof MouseEvent && ref.current?.contains(e.target as Node)) return;
      menu.set({ at: null });
    };
    window.addEventListener("mousedown", close, true);
    window.addEventListener("keydown", close, true);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("mousedown", close, true);
      window.removeEventListener("keydown", close, true);
      window.removeEventListener("blur", close);
    };
  }, [at]);

  // Keep the menu on screen once its size is known.
  if (at !== placed) {
    setPlaced(at);
    setPos(at);
  }
  useEffect(() => {
    const el = ref.current;
    if (!el || !at) return;
    const r = el.getBoundingClientRect();
    const x = Math.min(at.x, window.innerWidth - r.width - 4);
    const y = Math.min(at.y, window.innerHeight - r.height - 4);
    if (x !== pos?.x || y !== pos?.y) setPos({ x, y });
  }, [at, pos]);

  if (!at || !pos) return null;
  const modeCommands = COMMANDS.filter((c) => c.group === MODE_GROUP[mode] && c.modes?.includes(mode));
  const editCommands = COMMANDS.filter((c) => (c.group === "Edit" || c.group === "View") && c.modes?.includes(mode));
  const sel = state.selection;
  const item = (c: Command): React.JSX.Element => {
    const enabled = !c.enabled || c.enabled(state);
    return (
      <button
        key={c.id}
        role="menuitem"
        disabled={!enabled}
        onClick={() => {
          menu.set({ at: null });
          runCommand(c.id);
        }}
      >
        <span>{c.label}</span>
        {c.keys && <kbd>{c.keys}</kbd>}
      </button>
    );
  };
  return (
    <div className="context-menu" role="menu" ref={ref} style={{ left: pos.x, top: pos.y }}>
      <div className="menu-title">{sel ? `${sel.indices.length} ${sel.kind}${sel.indices.length === 1 ? "" : "s"} selected` : `${MODE_GROUP[mode]} mode`}</div>
      {modeCommands.map(item)}
      {modeCommands.length > 0 && editCommands.length > 0 && <hr />}
      {editCommands.map(item)}
    </div>
  );
}

export function CommandPalette(): React.JSX.Element | null {
  const open = useSyncExternalStore(
    (fn) => {
      palette.listeners.add(fn);
      return () => palette.listeners.delete(fn);
    },
    () => palette.open,
  );
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const state = useEditor((s) => s);
  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    return COMMANDS.filter((c) => !q || `${c.group} ${c.label} ${c.id}`.toLowerCase().includes(q));
  }, [query]);
  const close = (): void => {
    palette.open = false;
    for (const l of palette.listeners) l();
    setQuery("");
    setIndex(0);
  };
  if (!open) return null;
  const runAt = (i: number): void => {
    const c = list[i];
    if (!c || (c.enabled && !c.enabled(editor.get()))) return;
    close();
    runCommand(c.id);
  };
  return (
    <div className="dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="palette" role="dialog" aria-label="Command palette">
        <input
          autoFocus
          placeholder="Type a command…"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setIndex(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") close();
            else if (e.key === "ArrowDown") setIndex((i) => Math.min(list.length - 1, i + 1));
            else if (e.key === "ArrowUp") setIndex((i) => Math.max(0, i - 1));
            else if (e.key === "Enter") runAt(index);
            else return;
            e.preventDefault();
            e.stopPropagation();
          }}
        />
        <ul>
          {list.slice(0, 60).map((c, i) => {
            const enabled = !c.enabled || c.enabled(state);
            return (
              <li key={c.id}>
                <button className={i === index ? "active" : ""} disabled={!enabled} onMouseEnter={() => setIndex(i)} onClick={() => runAt(i)}>
                  <span className="group">{c.group}</span>
                  <span>{c.label}</span>
                  {c.keys && <kbd>{c.keys}</kbd>}
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
