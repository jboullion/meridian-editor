// Small form controls for the inspector. Number fields commit on Enter or blur,
// so typing "128" is one undo step, not three. A null value means the
// selected items differ ("mixed"); committing sets them all.

import { useState } from "react";

export function NumberField({
  label,
  value,
  onCommit,
  min,
  max,
  title,
  disabled,
}: {
  label: string;
  value: number | null;
  onCommit: (value: number) => void;
  min?: number;
  max?: number;
  title?: string;
  disabled?: boolean;
}): React.JSX.Element {
  const shownText = value === null ? "" : String(value);
  const [text, setText] = useState(shownText);
  // Follow outside changes (undo, another selection) without an effect.
  const [shown, setShown] = useState(value);
  if (shown !== value) {
    setShown(value);
    setText(shownText);
  }
  const clamp = (v: number): number => {
    if (min !== undefined) v = Math.max(min, v);
    if (max !== undefined) v = Math.min(max, v);
    return v;
  };
  const commit = (): void => {
    const n = Number(text);
    if (text.trim() === "" || !Number.isFinite(n)) {
      setText(shownText);
      return;
    }
    const v = clamp(Math.round(n));
    setText(String(v));
    if (v !== value) onCommit(v);
  };
  return (
    <label className="field" title={title}>
      <span>{label}</span>
      <input
        type="text"
        inputMode="numeric"
        value={text}
        placeholder={value === null ? "mixed" : undefined}
        disabled={disabled}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          if (e.key === "Escape") setText(shownText);
          if ((e.key === "ArrowUp" || e.key === "ArrowDown") && value !== null) {
            e.preventDefault();
            onCommit(clamp(value + (e.shiftKey ? 16 : 1) * (e.key === "ArrowUp" ? 1 : -1)));
          }
        }}
      />
    </label>
  );
}

export function Check({
  label,
  checked,
  onChange,
  title,
  warn,
}: {
  label: string;
  /** null: mixed across the selection. */
  checked: boolean | null;
  onChange: (v: boolean) => void;
  title?: string;
  warn?: boolean;
}): React.JSX.Element {
  return (
    <label className={`check${warn ? " warn" : ""}`} title={title}>
      <input
        type="checkbox"
        checked={!!checked}
        ref={(el) => {
          if (el) el.indeterminate = checked === null;
        }}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span>{label}</span>
    </label>
  );
}

export function Choice<T extends number | string>({
  label,
  value,
  options,
  onChange,
  title,
}: {
  label: string;
  value: T | null;
  options: readonly { value: T; label: string }[];
  onChange: (v: T) => void;
  title?: string;
}): React.JSX.Element {
  return (
    <label className="field" title={title}>
      <span>{label}</span>
      <select value={value === null ? "" : String(value)} onChange={(e) => e.target.value !== "" && onChange(options.find((o) => String(o.value) === e.target.value)!.value)}>
        {value === null && <option value="">mixed</option>}
        {options.map((o) => (
          <option key={String(o.value)} value={String(o.value)}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

export function Section({ title, children, actions }: { title: string; children: React.ReactNode; actions?: React.ReactNode }): React.JSX.Element {
  return (
    <section className="panel-section">
      <header>
        <h3>{title}</h3>
        {actions && <div className="section-actions">{actions}</div>}
      </header>
      <div className="section-body">{children}</div>
    </section>
  );
}

/** The shared value of `get` across items, or null if they differ. */
export function common<T, V>(items: readonly T[], get: (t: T) => V): V | null {
  if (items.length === 0) return null;
  const first = get(items[0]!);
  return items.every((t) => get(t) === first) ? first : null;
}

/** Read and write a bit field inside a flags word. */
export const bits = {
  get: (flags: number, mask: number, shift: number): number => (flags & mask) >>> shift,
  set: (flags: number, mask: number, shift: number, value: number): number => ((flags & ~mask) | ((value << shift) & mask)) | 0,
  flag: (flags: number, bit: number, on: boolean): number => (on ? flags | bit : flags & ~bit) | 0,
};

export const SCROLL_SPEEDS = [
  { value: 0, label: "None" },
  { value: 1, label: "Slow" },
  { value: 2, label: "Medium" },
  { value: 3, label: "Fast" },
] as const;

export const SCROLL_DIRECTIONS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"].map((label, value) => ({ value, label }));

export const hex = (v: number): string => `0x${(v >>> 0).toString(16)}`;
