// Modal dialogs: one at a time, opened imperatively and resolved with a value.

import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { Store } from "./store.ts";

interface Open {
  title: string;
  wide: boolean;
  render: (done: (value: unknown) => void) => ReactNode;
  resolve: (value: unknown) => void;
}

const dialogs = new Store<{ open: Open | null }>({ open: null });

export function openDialog<T>(title: string, render: (done: (value: T | null) => void) => ReactNode, options: { wide?: boolean } = {}): Promise<T | null> {
  return new Promise((resolve) => {
    dialogs.get().open?.resolve(null);
    dialogs.set({
      open: {
        title,
        wide: !!options.wide,
        render: render as Open["render"],
        resolve: (value) => {
          dialogs.set({ open: null });
          resolve(value as T | null);
        },
      },
    });
  });
}

export function DialogHost(): React.JSX.Element | null {
  const open = useSyncExternalStore(dialogs.subscribe, () => dialogs.get().open);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.stopPropagation();
        open.resolve(null);
      }
    };
    window.addEventListener("keydown", onKey, true);
    // Focus the first field.
    setTimeout(() => ref.current?.querySelector<HTMLElement>("input, select, textarea, button")?.focus(), 0);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open]);
  if (!open) return null;
  return (
    <div className="dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && open.resolve(null)}>
      <div className={`dialog${open.wide ? " wide" : ""}`} role="dialog" aria-modal="true" aria-label={open.title} ref={ref}>
        <header className="dialog-head">
          <h2>{open.title}</h2>
          <button className="small" onClick={() => open.resolve(null)} aria-label="Close">
            ✕
          </button>
        </header>
        <div className="dialog-body">{open.render(open.resolve)}</div>
      </div>
    </div>
  );
}

export type FieldSpec =
  | { key: string; label: string; type: "number"; min?: number; max?: number; step?: number; hint?: string }
  | { key: string; label: string; type: "text"; hint?: string }
  | { key: string; label: string; type: "checkbox"; hint?: string }
  | { key: string; label: string; type: "select"; options: readonly { value: string | number; label: string }[]; hint?: string };

/** A small form; resolves with the values, or null if cancelled. */
export function promptForm<T extends Record<string, unknown>>(title: string, fields: readonly FieldSpec[], initial: T, submit = "OK", intro?: ReactNode): Promise<T | null> {
  return openDialog<T>(title, (done) => <Form fields={fields} initial={initial} submit={submit} intro={intro} onDone={done} />);
}

function Form<T extends Record<string, unknown>>({
  fields,
  initial,
  submit,
  intro,
  onDone,
}: {
  fields: readonly FieldSpec[];
  initial: T;
  submit: string;
  intro?: ReactNode;
  onDone: (v: T | null) => void;
}): React.JSX.Element {
  const [values, setValues] = useState<Record<string, unknown>>(initial);
  const set = (key: string, v: unknown): void => setValues((old) => ({ ...old, [key]: v }));
  return (
    <form
      className="form"
      onSubmit={(e) => {
        e.preventDefault();
        onDone(values as T);
      }}
    >
      {intro && <div className="hint">{intro}</div>}
      {fields.map((f) => (
        <label key={f.key} className={f.type === "checkbox" ? "check" : "field"}>
          {f.type === "checkbox" ? (
            <>
              <input type="checkbox" checked={!!values[f.key]} onChange={(e) => set(f.key, e.target.checked)} />
              <span>{f.label}</span>
            </>
          ) : (
            <>
              <span>{f.label}</span>
              {f.type === "select" ? (
                <select value={String(values[f.key])} onChange={(e) => set(f.key, f.options.find((o) => String(o.value) === e.target.value)!.value)}>
                  {f.options.map((o) => (
                    <option key={String(o.value)} value={String(o.value)}>
                      {o.label}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  type={f.type === "number" ? "number" : "text"}
                  value={String(values[f.key] ?? "")}
                  min={f.type === "number" ? f.min : undefined}
                  max={f.type === "number" ? f.max : undefined}
                  step={f.type === "number" ? (f.step ?? 1) : undefined}
                  onChange={(e) => set(f.key, f.type === "number" ? Number(e.target.value) : e.target.value)}
                />
              )}
            </>
          )}
          {f.hint && <small className="hint">{f.hint}</small>}
        </label>
      ))}
      <div className="dialog-actions">
        <button type="button" onClick={() => onDone(null)}>
          Cancel
        </button>
        <button type="submit" className="primary">
          {submit}
        </button>
      </div>
    </form>
  );
}

export function confirmDialog(title: string, message: ReactNode, ok = "OK"): Promise<boolean> {
  return openDialog<boolean>(title, (done) => (
    <div className="form">
      <div>{message}</div>
      <div className="dialog-actions">
        <button onClick={() => done(false)}>Cancel</button>
        <button className="primary" onClick={() => done(true)}>
          {ok}
        </button>
      </div>
    </div>
  )).then((v) => !!v);
}

export function showDialog(title: string, body: ReactNode, wide = false): Promise<null> {
  return openDialog<null>(
    title,
    (done) => (
      <div className="form">
        {body}
        <div className="dialog-actions">
          <button className="primary" onClick={() => done(null)}>
            Close
          </button>
        </div>
      </div>
    ),
    { wide },
  );
}
