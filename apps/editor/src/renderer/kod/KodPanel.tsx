// The bottom panel's Kod tab: which room class the open room is, and every
// exit, generator, object and sound its Kod places, each a link to its spot on
// the map. Read-only: placements are edited in the .kod file.

import { runCommand } from "../commands.tsx";
import { editor, requestView, useEditor } from "../store.ts";
import { kod, kodMarks, roomBox, useKod, useKodRoom, type KodMark } from "./kodStore.ts";

const GROUPS: { title: string; kinds: KodMark["kind"][] }[] = [
  { title: "Exits", kinds: ["exit", "locked"] },
  { title: "Monster generators", kinds: ["generator"] },
  { title: "Objects", kinds: ["object"] },
  { title: "Sounds", kinds: ["sound"] },
  { title: "Arrival", kinds: ["arrival"] },
];

export function KodPanel(): React.JSX.Element {
  const { candidates, room: k } = useKodRoom();
  const error = useKod((s) => s.error);
  const loading = useKod((s) => s.loading);
  const show = useKod((s) => s.show);
  const dir = useKod((s) => s.index?.dir ?? "");
  const doc = useEditor((s) => s.doc);
  const room = useEditor((s) => s.room);
  const box = room && roomBox(room.things);

  if (loading) return <p className="hint pad">Reading the Kod…</p>;
  if (!k || !box) {
    return (
      <p className="hint pad">
        {error ?? `No room class in ${dir || "the Kod folder"} uses ${doc ? doc.name.replace(/\.room\.json$/i, "") + ".roo" : "this room"}.`}{" "}
        <button className="small" onClick={() => runCommand("view.kodReload")}>
          Reload
        </button>
      </p>
    );
  }
  const marks = kodMarks(k, box);
  return (
    <div className="kod-panel">
      <div className="kod-head">
        {candidates.length > 1 ? (
          <select
            value={k.className}
            onChange={(e) => doc && kod.set((s) => ({ picked: { ...s.picked, [doc.name]: e.target.value } }))}
            title="Several classes use this .roo"
          >
            {candidates.map((c) => (
              <option key={c.className} value={c.className}>
                {c.className}
              </option>
            ))}
          </select>
        ) : (
          <strong>{k.className}</strong>
        )}
        <span className="hint">
          {k.path} · {k.ridName ?? "no RID"}
          {k.rid !== null && k.ridName !== String(k.rid) ? ` (${k.rid})` : ""} · {k.roo}
        </span>
        <span className="spacer" />
        <label className="inline">
          <input type="checkbox" checked={show} onChange={(e) => kod.set({ show: e.target.checked })} /> Show on map (K)
        </label>
        <button className="small" onClick={() => runCommand("check.kod")}>
          Check placements
        </button>
        <button className="small" onClick={() => runCommand("view.kodReload")}>
          Reload
        </button>
      </div>
      {k.edgeExits.length > 0 && (
        <p className="kod-edges">
          Edge exits:{" "}
          {k.edgeExits.map((e, i) => (
            <span key={i}>
              {i > 0 && " · "}
              {e.side} to {e.dest}
              {e.destRow !== undefined && ` (${e.destRow}, ${e.destCol})`}
            </span>
          ))}
        </p>
      )}
      <div className="kod-groups">
        {GROUPS.map((g) => {
          const items = marks.filter((m) => g.kinds.includes(m.kind));
          if (!items.length) return null;
          return (
            <section key={g.title}>
              <h4>
                {g.title} · {items.length}
              </h4>
              <ul>
                {items.map((m, i) => (
                  <li key={i}>
                    <button
                      className="link"
                      title={`${k.path}:${m.line}`}
                      onClick={() => {
                        requestView({ kind: "center", x: m.x, y: m.y });
                        if (!kod.get().show) kod.set({ show: true });
                        editor.set({ message: { text: `${m.label}: Kod row ${m.row}, col ${m.col} (${k.path}:${m.line})`, kind: "info" } });
                      }}
                    >
                      {m.row}, {m.col} · {m.label}
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </div>
    </div>
  );
}
