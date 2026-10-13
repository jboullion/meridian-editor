// Texture thumbnails, a field with a swatch, and the picker / browser dialog
// (roomedit's "View wall textures" and its texture lists).

import { useEffect, useMemo, useRef, useState } from "react";
import { openDialog } from "../dialogs.tsx";
import { library, reloadLibrary, useLibrary, useTexture } from "./library.ts";

export function Swatch({ number, size = 28 }: { number: number; size?: number }): React.JSX.Element {
  const tex = useTexture(number);
  const style = { width: size, height: size };
  if (number === 0) return <span className="swatch none" style={style} title="No texture" />;
  if (tex === undefined) return <span className="swatch loading" style={style} />;
  if (tex === null) return <span className="swatch missing" style={style} title={`Texture ${number} isn't in the library`} />;
  return <img className="swatch" style={style} src={tex.url} alt="" title={`Texture ${number} · ${tex.width}×${tex.height}`} />;
}

/** A texture number field with a thumbnail that opens the picker. */
export function TextureField({ label, value, onCommit, title }: { label: string; value: number; onCommit: (v: number) => void; title?: string }): React.JSX.Element {
  const [text, setText] = useState(String(value));
  const [shown, setShown] = useState(value);
  if (shown !== value) {
    setShown(value);
    setText(String(value));
  }
  const commit = (): void => {
    const n = Math.trunc(Number(text));
    if (!Number.isFinite(n) || n < 0 || n > 65535) return setText(String(value));
    if (n !== value) onCommit(n);
  };
  return (
    <label className="field texture-field" title={title}>
      <span>{label}</span>
      <div className="texture-input">
        <button
          type="button"
          className="swatch-button"
          onClick={() => void pickTexture(value).then((n) => n !== null && n !== value && onCommit(n))}
          title="Choose a texture"
        >
          <Swatch number={value} size={24} />
        </button>
        <input value={text} inputMode="numeric" onChange={(e) => setText(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === "Enter" && commit()} />
      </div>
    </label>
  );
}

export function pickTexture(current: number): Promise<number | null> {
  return openDialog<number>("Choose texture", (done) => <TextureBrowser current={current} onPick={done} />, { wide: true });
}

export function browseTextures(): Promise<number | null> {
  return openDialog<number>("Textures", (done) => <TextureBrowser current={-1} onPick={done} />, { wide: true });
}

function TextureBrowser({ current, onPick }: { current: number; onPick: (n: number | null) => void }): React.JSX.Element {
  const numbers = useLibrary((s) => s.numbers);
  const dir = useLibrary((s) => s.dir);
  const loading = useLibrary((s) => s.loading);
  const [filter, setFilter] = useState("");
  const shown = useMemo(() => {
    const f = filter.trim();
    const list = [0, ...numbers];
    return f ? list.filter((n) => String(n).includes(f)) : list;
  }, [numbers, filter]);
  useEffect(() => {
    if (!library.get().numbers.length && !library.get().loading) void reloadLibrary();
  }, []);
  return (
    <div className="texture-browser">
      <div className="texture-browser-head">
        <input type="search" placeholder={`Filter ${numbers.length} textures by number`} value={filter} onChange={(e) => setFilter(e.target.value)} autoFocus />
        <span className="hint" title={dir}>
          {loading ? "Loading…" : dir ? `${numbers.length} in ${dir}` : "No textures folder (set it in Preferences)"}
        </span>
      </div>
      <div className="texture-grid">
        {shown.slice(0, 2000).map((n) => (
          <LazyTile key={n} number={n} active={n === current} onPick={() => onPick(n)} />
        ))}
      </div>
    </div>
  );
}

function LazyTile({ number, active, onPick }: { number: number; active: boolean; onPick: () => void }): React.JSX.Element {
  const ref = useRef<HTMLButtonElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        setVisible(true);
        io.disconnect();
      }
    });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return (
    <button ref={ref} className={`texture-tile${active ? " active" : ""}`} onClick={onPick} title={number === 0 ? "No texture" : `Texture ${number}`}>
      {visible ? <Swatch number={number} size={72} /> : <span className="swatch loading" style={{ width: 72, height: 72 }} />}
      <span>{number === 0 ? "none" : number}</span>
    </button>
  );
}
