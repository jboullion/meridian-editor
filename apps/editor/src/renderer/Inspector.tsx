// Properties of the selection — one item or many (changes apply to all of
// them; values that differ show as "mixed") — or of a Kod exit picked on the
// map, or of the room when nothing is selected. roomedit's Edit Object
// dialogs, as a panel.

import { PROFILES, SF, WF } from "@meridian-editor/roo";
import type { RoomSource, SourceSector, SourceSide, SourceSlope, SourceThing } from "@meridian-editor/roomc";
import { changeKodExit, runCommand } from "./commands.tsx";
import { useCompiled } from "./compiler.ts";
import { bits, Check, Choice, common, hex, NumberField, SCROLL_DIRECTIONS, SCROLL_SPEEDS, Section } from "./fields.tsx";
import { kodCoords, roomBoxSize } from "./geometry.ts";
import { exitSpec, type ExitSpec } from "./kod/kodEdit.ts";
import { useKodRoom } from "./kod/kodStore.ts";
import { baseName } from "./host.ts";
import { moveItems, sectorVertices, THING_TYPES } from "./ops/edit.ts";
import { OpError } from "./ops/types.ts";
import { TextureField } from "./textures/TexturePicker.tsx";
import { edit, kodDirty, selectOne, useEditor, type ItemKind } from "./store.ts";

export function Inspector(): React.JSX.Element {
  const room = useEditor((s) => s.room);
  const selection = useEditor((s) => s.selection);
  const kodExit = useEditor((s) => s.kodExit);
  if (!room) return <div className="inspector empty">Open a room to edit it.</div>;
  const n = selection?.indices.length ?? 0;
  return (
    <div className="inspector">
      {kodExit !== null && <KodExitPanel index={kodExit} />}
      {!selection && kodExit === null && <RoomPanel room={room} />}
      {selection?.kind === "vertex" && <VertexPanel room={room} indices={selection.indices} />}
      {selection?.kind === "linedef" && <LinedefPanel room={room} indices={selection.indices} />}
      {selection?.kind === "sector" && <SectorPanel room={room} indices={selection.indices} />}
      {selection?.kind === "thing" && <ThingPanel room={room} indices={selection.indices} />}
      {selection && n > 0 && <OperationsHint kind={selection.kind} />}
    </div>
  );
}

function OperationsHint({ kind }: { kind: ItemKind }): React.JSX.Element {
  return (
    <p className="hint pad">
      Right-click the map (or press Ctrl+Shift+P) for {kind} operations{kind === "linedef" ? ": split, flip, align textures, join sectors…" : kind === "sector" ? ": merge, door, lift, slopes…" : kind === "vertex" ? ": merge, join, link…" : "."}
    </p>
  );
}

// ---------------------------------------------------------------- room

function RoomPanel({ room }: { room: RoomSource }): React.JSX.Element {
  const target = useEditor((s) => s.target);
  const file = useCompiled((s) => s.result?.file);
  const size = roomBoxSize(room);
  return (
    <>
      <Section title="Room">
        <NumberField label="Room ID" value={room.roomId} min={0} title="The RID Kod refers to this room by (roomedit: Set Room ID)" onCommit={(v) => edit((r) => ({ ...r, roomId: v }))} />
        <dl className="stats">
          <dt>Vertices</dt>
          <dd>{room.vertices.length}</dd>
          <dt>Linedefs</dt>
          <dd>{room.linedefs.length}</dd>
          <dt>Sectors</dt>
          <dd>{room.sectors.length}</dd>
          <dt>Things</dt>
          <dd>{room.things.length}</dd>
          {size && (
            <>
              <dt>Size</dt>
              <dd>
                {size.width} × {size.height} squares
              </dd>
            </>
          )}
          {file && (
            <>
              <dt>Compiled</dt>
              <dd>
                v{file.version} · {file.nodes.length} nodes · {file.clientWalls.length} walls · {file.sidedefs.length} sidedefs
              </dd>
            </>
          )}
        </dl>
      </Section>
      <Section title="Target">
        <p className="hint">{PROFILES[target].description}.</p>
        {target === "104" && room.things.length !== 2 && <p className="warn-text">Server 104 only loads rooms with exactly two things.</p>}
      </Section>
      {room.compat && (
        <Section
          title="Compatibility"
          actions={
            <button className="small" onClick={() => edit((r) => ({ ...r, compat: undefined }))} title="Compile the way current roomedit does">
              Clear
            </button>
          }
        >
          <p className="hint">This room was imported from a file saved by an older roomedit. These flags make it recompile byte for byte; new rooms don't need them.</p>
          <ul className="compat">
            {room.compat.mirrorMissingBackOffsets && <li>Missing back sides repeat the front offsets (editor section only)</li>}
            {room.compat.flipKeepsYOffsets && <li>BSP wall flips keep y offsets</li>}
            {room.compat.floatSlopes && <li>Slope planes computed in float</li>}
          </ul>
        </Section>
      )}
      <Section title="Getting around">
        <ul className="tips">
          <li>
            <b>Modes</b> T things · V vertices · L linedefs · S sectors (Tab cycles). Clicks pick only the current mode.
          </li>
          <li>
            <b>Select</b> click, Shift-click to add, drag a box; drag the selection to move it. Right-click for operations.
          </li>
          <li>
            <b>Draw</b> D: click points, click the first one to make a sector, double-click or Enter to stop. Lines split walls and sectors they cross.
          </li>
          <li>
            <b>Shapes</b> R rectangle, 4 polygon, 5 circle, 6 torch, 7 thing. Esc returns to Select.
          </li>
          <li>Wheel zooms; middle-drag or Space+drag pans; F fits; G/Shift+G grid; Ctrl+Shift+P lists every command.</li>
        </ul>
      </Section>
    </>
  );
}

// ---------------------------------------------------------------- vertices

function VertexPanel({ room, indices }: { room: RoomSource; indices: number[] }): React.JSX.Element {
  if (indices.length > 1) {
    return (
      <Section title={`${indices.length} vertices`}>
        <p className="hint">Drag to move them together, or right-click to merge, link or join.</p>
        <MoveBy kind="vertex" indices={indices} />
      </Section>
    );
  }
  const index = indices[0]!;
  const v = room.vertices[index];
  if (!v) return <></>;
  const users = room.linedefs.flatMap((l, i) => (l.start === index || l.end === index ? [i] : []));
  const setTo = (x: number, y: number): void =>
    void edit((r) => {
      const [ox, oy] = r.vertices[index]!;
      const vertices = r.vertices.slice();
      vertices[index] = [x, y];
      const fix = (slope: SourceSlope | null): SourceSlope | null =>
        slope && { ...slope, points: slope.points.map(([px, py, pz]) => (px === ox && py === oy ? [x, y, pz] : [px, py, pz])) as SourceSlope["points"] };
      return { ...r, vertices, sectors: r.sectors.map((s) => ({ ...s, floorSlope: fix(s.floorSlope), ceilingSlope: fix(s.ceilingSlope) })) };
    });
  return (
    <Section title={`Vertex ${index}`}>
      <div className="row">
        <NumberField label="X" value={v[0]} min={-32768} max={32767} onCommit={(x) => setTo(x, v[1])} />
        <NumberField label="Y" value={v[1]} min={-32768} max={32767} onCommit={(y) => setTo(v[0], y)} />
      </div>
      <KodLine room={room} x={v[0]} y={v[1]} />
      <p className="hint">Used by linedefs {users.length ? users.map((i) => <ItemLink key={i} kind="linedef" index={i} />) : "none"}</p>
    </Section>
  );
}

function MoveBy({ kind, indices }: { kind: ItemKind; indices: number[] }): React.JSX.Element {
  return (
    <div className="row">
      <NumberField label="Move X by" value={0} onCommit={(dx) => void edit((r) => moveItems(r, kind, indices, dx, 0))} />
      <NumberField label="Move Y by" value={0} onCommit={(dy) => void edit((r) => moveItems(r, kind, indices, 0, dy))} />
    </div>
  );
}

// ---------------------------------------------------------------- linedefs and sides

function LinedefPanel({ room, indices }: { room: RoomSource; indices: number[] }): React.JSX.Element {
  const target = useEditor((s) => s.target);
  const lines = indices.map((i) => room.linedefs[i]!).filter(Boolean);
  if (lines.length === 0) return <></>;
  const single = indices.length === 1 ? indices[0]! : null;
  return (
    <>
      <Section
        title={single !== null ? `Linedef ${single}` : `${indices.length} linedefs`}
        actions={
          <>
            <button className="small" title="Swap ends and sides" onClick={() => runCommand("linedef.flip")}>
              Flip
            </button>
            <button className="small" title="Add a vertex in the middle" onClick={() => runCommand("linedef.split")}>
              Split
            </button>
            <button className="small danger" title="Delete" onClick={() => runCommand("edit.delete")}>
              Delete
            </button>
          </>
        }
      >
        {single !== null ? (
          <LinedefInfo room={room} index={single} />
        ) : (
          <p className="hint">
            Changes below apply to every selected linedef that has that side. Total length {Math.round(lines.reduce((a, l) => a + len(room, l.start, l.end), 0))}.
          </p>
        )}
      </Section>
      <SidePanel room={room} indices={indices} which="front" target={target} />
      <SidePanel room={room} indices={indices} which="back" target={target} />
    </>
  );
}

const len = (room: RoomSource, a: number, b: number): number => Math.hypot(room.vertices[b]![0] - room.vertices[a]![0], room.vertices[b]![1] - room.vertices[a]![1]);

function LinedefInfo({ room, index }: { room: RoomSource; index: number }): React.JSX.Element {
  const l = room.linedefs[index]!;
  const a = room.vertices[l.start]!;
  const b = room.vertices[l.end]!;
  return (
    <dl className="stats">
      <dt>From</dt>
      <dd>
        <ItemLink kind="vertex" index={l.start} /> ({a[0]}, {a[1]})
      </dd>
      <dt>To</dt>
      <dd>
        <ItemLink kind="vertex" index={l.end} /> ({b[0]}, {b[1]})
      </dd>
      <dt>Length</dt>
      <dd>{Math.round(len(room, l.start, l.end))}</dd>
    </dl>
  );
}

function SidePanel({ room, indices, which, target }: { room: RoomSource; indices: number[]; which: "front" | "back"; target: string }): React.JSX.Element {
  const title = which === "front" ? "Front side (+)" : "Back side (−)";
  const withSide = indices.filter((i) => room.linedefs[i]![which]);
  const sides = withSide.map((i) => room.linedefs[i]![which]!);
  const without = indices.filter((i) => !room.linedefs[i]![which]);

  const addSides = (): void =>
    void edit((r) => {
      const linedefs = r.linedefs.slice();
      for (const i of without) {
        const l = linedefs[i]!;
        const other = which === "front" ? l.back : l.front;
        const side: SourceSide = other
          ? { ...other, xOffset: 0, yOffset: 0 }
          : { sector: 0, normal: 0, above: 0, below: 0, xOffset: 0, yOffset: 0, serverId: 0, animateSpeed: 0, flags: 0 };
        linedefs[i] = { ...l, [which]: side };
      }
      return { ...r, linedefs };
    });

  if (sides.length === 0) {
    return (
      <Section
        title={title}
        actions={
          <button className="small" onClick={addSides}>
            Add
          </button>
        }
      >
        <p className="hint">No side: this face is solid, seen only from the other side.</p>
      </Section>
    );
  }

  const setEach = (fn: (s: SourceSide) => Partial<SourceSide>): void =>
    void edit((r) => {
      const linedefs = r.linedefs.slice();
      for (const i of withSide) {
        const l = linedefs[i]!;
        const s = l[which]!;
        linedefs[i] = { ...l, [which]: { ...s, ...fn(s) } };
      }
      return { ...r, linedefs };
    });
  const set = (patch: Partial<SourceSide>): void => setEach(() => patch);
  const c = <V,>(get: (s: SourceSide) => V): V | null => common(sides, get);
  const flag = (label: string, bit: number, title?: string, originalOnly = false): React.JSX.Element => {
    const on = c((s) => (s.flags & bit) !== 0);
    return <Check label={label} title={title} checked={on} warn={originalOnly && target === "104" && on !== false} onChange={(v) => setEach((s) => ({ flags: bits.flag(s.flags, bit, v) }))} />;
  };
  const known = 0x7fff | WF.TRANSLUCENCY_MASK | WF.NO_HTILE;
  const sector = c((s) => s.sector);
  const extra = c((s) => s.flags & ~known);

  return (
    <Section
      title={`${title}${withSide.length < indices.length ? ` · ${withSide.length} of ${indices.length}` : ""}`}
      actions={
        <>
          {without.length > 0 && (
            <button className="small" onClick={addSides}>
              Add to rest
            </button>
          )}
          <button
            className="small danger"
            onClick={() =>
              void edit((r) => {
                const linedefs = r.linedefs.slice();
                for (const i of withSide) linedefs[i] = { ...linedefs[i]!, [which]: null };
                return { ...r, linedefs };
              })
            }
          >
            Remove
          </button>
        </>
      }
    >
      <div className="row">
        <NumberField label="Sector" value={sector} min={-1} max={room.sectors.length - 1} onCommit={(v) => set({ sector: v })} />
        {sector !== null && sector >= 0 && <ItemLink kind="sector" index={sector} label="select sector" />}
      </div>
      <div className="row three">
        <TextureField label="Normal" value={c((s) => s.normal) ?? 0} onCommit={(v) => set({ normal: v })} title="Main wall texture" />
        <TextureField label="Above" value={c((s) => s.above) ?? 0} onCommit={(v) => set({ above: v })} title="Upper texture, where the far ceiling is lower" />
        <TextureField label="Below" value={c((s) => s.below) ?? 0} onCommit={(v) => set({ below: v })} title="Lower texture, where the far floor is higher" />
      </div>
      <div className="row three">
        <NumberField label="X offset" value={c((s) => s.xOffset)} min={-32768} max={32767} onCommit={(v) => set({ xOffset: v })} />
        <NumberField label="Y offset" value={c((s) => s.yOffset)} min={-32768} max={32767} onCommit={(v) => set({ yOffset: v })} />
        <NumberField label="Server ID" value={c((s) => s.serverId)} min={0} max={65535} title="Kod AnimateWall / ChangeTexture id" onCommit={(v) => set({ serverId: v })} />
      </div>
      <div className="row three">
        <NumberField label="Animate" value={c((s) => s.animateSpeed)} min={0} max={255} title="Animation speed (tenths of a frame per second)" onCommit={(v) => set({ animateSpeed: v })} />
        <Choice label="Scroll" value={c((s) => bits.get(s.flags, WF.SCROLL_SPEED_MASK, 10))} options={SCROLL_SPEEDS} onChange={(v) => setEach((s) => ({ flags: bits.set(s.flags, WF.SCROLL_SPEED_MASK, 10, v) }))} />
        <Choice label="Direction" value={c((s) => bits.get(s.flags, WF.SCROLL_DIRECTION_MASK, 12))} options={SCROLL_DIRECTIONS} onChange={(v) => setEach((s) => ({ flags: bits.set(s.flags, WF.SCROLL_DIRECTION_MASK, 12, v) }))} />
      </div>
      <div className="checks">
        {flag("Passable", WF.PASSABLE)}
        {flag("Transparent", WF.TRANSPARENT, "Drawn with see-through pixels")}
        {flag("Blocks sight", WF.NOLOOKTHROUGH, "No line of sight through this wall")}
        {flag("Backwards", WF.BACKWARDS, "Mirror the texture horizontally")}
        {flag("Above bottom-up", WF.ABOVE_BOTTOMUP)}
        {flag("Below top-down", WF.BELOW_TOPDOWN)}
        {flag("Normal top-down", WF.NORMAL_TOPDOWN)}
        {flag("No vertical tile", WF.NO_VTILE)}
        {flag("Never on map", WF.MAP_NEVER)}
        {flag("Always on map", WF.MAP_ALWAYS)}
        {flag("No horizontal tile", WF.NO_HTILE, "Original server only", true)}
      </div>
      <Choice
        label="Translucency (original only)"
        value={c((s) => bits.get(s.flags, WF.TRANSLUCENCY_MASK, 15))}
        options={[
          { value: 0, label: "Opaque" },
          { value: 1, label: "25% visible" },
          { value: 2, label: "50% visible" },
          { value: 3, label: "75% visible" },
        ]}
        onChange={(v) => setEach((s) => ({ flags: bits.set(s.flags, WF.TRANSLUCENCY_MASK, 15, v) }))}
      />
      {extra !== 0 && extra !== null && <p className="hint">Other bits {hex(extra)} are kept as they are.</p>}
    </Section>
  );
}

// ---------------------------------------------------------------- sectors

function SectorPanel({ room, indices }: { room: RoomSource; indices: number[] }): React.JSX.Element {
  const target = useEditor((st) => st.target);
  const sectors = indices.map((i) => room.sectors[i]!).filter(Boolean);
  if (sectors.length === 0) return <></>;
  const setEach = (fn: (s: SourceSector) => Partial<SourceSector>): void =>
    void edit((r) => {
      const all = r.sectors.slice();
      for (const i of indices) all[i] = { ...all[i]!, ...fn(all[i]!) };
      return { ...r, sectors: all };
    });
  const set = (patch: Partial<SourceSector>): void => setEach(() => patch);
  const c = <V,>(get: (s: SourceSector) => V): V | null => common(sectors, get);
  const flagCheck = (label: string, bit: number): React.JSX.Element => (
    <Check label={label} checked={c((s) => (s.flags & bit) !== 0)} onChange={(on) => setEach((s) => ({ flags: bits.flag(s.flags, bit, on) }))} />
  );
  const single = indices.length === 1 ? indices[0]! : null;
  const extra = c((s) => s.flags & ~0xfff);
  const negative = target === "104" && sectors.some((s) => s.floorHeight < 0 || s.ceilingHeight < 0);
  return (
    <>
      <Section title={single !== null ? `Sector ${single}` : `${indices.length} sectors`}>
        <div className="row three">
          <NumberField label="Server ID" value={c((s) => s.serverId)} min={0} max={65535} title="Kod SetSector / SetSectorLight id" onCommit={(v) => set({ serverId: v })} />
          <NumberField label="Light" value={c((s) => s.light)} min={0} max={255} title="0-127 ignore the room's ambient light, 128-255 add to it" onCommit={(v) => set({ light: v })} />
          <NumberField label="Animate" value={c((s) => s.animateSpeed)} min={0} max={255} onCommit={(v) => set({ animateSpeed: v })} />
        </div>
        <div className="row">
          <NumberField label="Floor height" value={c((s) => s.floorHeight)} min={-32768} max={32767} onCommit={(v) => set({ floorHeight: v })} />
          <NumberField label="Ceiling height" value={c((s) => s.ceilingHeight)} min={-32768} max={32767} onCommit={(v) => set({ ceilingHeight: v })} />
        </div>
        {negative && <p className="warn-text">Server 104 reads heights as unsigned; keep them at 0 or above.</p>}
        <div className="row">
          <TextureField label="Floor texture" value={c((s) => s.floorTexture) ?? 0} onCommit={(v) => set({ floorTexture: v })} />
          <TextureField label="Ceiling texture" value={c((s) => s.ceilingTexture) ?? 0} onCommit={(v) => set({ ceilingTexture: v })} />
        </div>
        <div className="row">
          <NumberField label="Texture X offset" value={c((s) => s.xOffset)} min={-32768} max={32767} onCommit={(v) => set({ xOffset: v })} />
          <NumberField label="Texture Y offset" value={c((s) => s.yOffset)} min={-32768} max={32767} onCommit={(v) => set({ yOffset: v })} />
        </div>
        <div className="row three">
          <Choice
            label="Depth"
            value={c((s) => bits.get(s.flags, SF.DEPTH_MASK, 0))}
            options={[
              { value: 0, label: "None" },
              { value: 1, label: "Shallow" },
              { value: 2, label: "Deep" },
              { value: 3, label: "Very deep" },
            ]}
            onChange={(v) => setEach((s) => ({ flags: bits.set(s.flags, SF.DEPTH_MASK, 0, v) }))}
          />
          <Choice label="Scroll" value={c((s) => bits.get(s.flags, SF.SCROLL_SPEED_MASK, 2))} options={SCROLL_SPEEDS} onChange={(v) => setEach((s) => ({ flags: bits.set(s.flags, SF.SCROLL_SPEED_MASK, 2, v) }))} />
          <Choice label="Direction" value={c((s) => bits.get(s.flags, SF.SCROLL_DIRECTION_MASK, 4))} options={SCROLL_DIRECTIONS} onChange={(v) => setEach((s) => ({ flags: bits.set(s.flags, SF.SCROLL_DIRECTION_MASK, 4, v) }))} />
        </div>
        <div className="checks">
          {flagCheck("Scroll floor", SF.SCROLL_FLOOR)}
          {flagCheck("Scroll ceiling", SF.SCROLL_CEILING)}
          {flagCheck("Flicker", SF.FLICKER)}
        </div>
        {extra !== 0 && extra !== null && <p className="hint">Other bits {hex(extra)} are kept as they are.</p>}
      </Section>
      {single !== null && <SlopePanel room={room} index={single} floor />}
      {single !== null && <SlopePanel room={room} index={single} floor={false} />}
    </>
  );
}

function SlopePanel({ room, index, floor }: { room: RoomSource; index: number; floor: boolean }): React.JSX.Element {
  const s = room.sectors[index]!;
  const slope = floor ? s.floorSlope : s.ceilingSlope;
  const bit = floor ? SF.SLOPED_FLOOR : SF.SLOPED_CEILING;
  const key = floor ? "floorSlope" : "ceilingSlope";
  const title = floor ? "Floor slope" : "Ceiling slope";
  if (!slope) {
    return (
      <Section
        title={title}
        actions={
          <button className="small" onClick={() => runCommand(floor ? "sector.floorSlope" : "sector.ceilingSlope")}>
            Add
          </button>
        }
      >
        <p className="hint">Flat. A slope rests on three of the sector's vertices, each at its own height.</p>
      </Section>
    );
  }
  const enabled = (s.flags & bit) !== 0;
  const verts = sectorVertices(room, index);
  const setSlope = (next: SourceSlope): void => void edit((r) => ({ ...r, sectors: r.sectors.map((x, i) => (i === index ? { ...x, [key]: next } : x)) }));
  const setPoint = (i: number, p: [number, number, number]): void => setSlope({ ...slope, points: slope.points.map((q, j) => (j === i ? p : q)) as SourceSlope["points"] });
  return (
    <Section
      title={title}
      actions={
        <button
          className="small danger"
          onClick={() => void edit((r) => ({ ...r, sectors: r.sectors.map((x, i) => (i === index ? { ...x, flags: x.flags & ~bit, [key]: null } : x)) }))}
        >
          Remove
        </button>
      }
    >
      <Check label="Sloped" checked={enabled} onChange={(on) => void edit((r) => ({ ...r, sectors: r.sectors.map((x, i) => (i === index ? { ...x, flags: bits.flag(x.flags, bit, on) } : x)) }))} />
      {slope.points.map(([x, y, z], i) => {
        const at = verts.findIndex((v) => room.vertices[v]![0] === x && room.vertices[v]![1] === y);
        return (
          <div className="row" key={i}>
            <Choice
              label={`Point ${i + 1}`}
              value={at >= 0 ? verts[at]! : -1}
              options={[...(at < 0 ? [{ value: -1, label: `(${x}, ${y}) — not a vertex` }] : []), ...verts.map((v) => ({ value: v, label: `vertex ${v} (${room.vertices[v]![0]}, ${room.vertices[v]![1]})` }))]}
              onChange={(v) => v >= 0 && setPoint(i, [room.vertices[v]![0], room.vertices[v]![1], z])}
            />
            <NumberField label="Height" value={z} onCommit={(nz) => setPoint(i, [x, y, nz])} />
          </div>
        );
      })}
      <NumberField
        label="Texture angle (°)"
        value={Math.round((slope.angle * 360) / 4096)}
        title="Stored in client units (4096 per circle)"
        onCommit={(deg) => setSlope({ ...slope, angle: Math.trunc((deg * 4096) / 360) })}
      />
    </Section>
  );
}

// ---------------------------------------------------------------- things

function ThingPanel({ room, indices }: { room: RoomSource; indices: number[] }): React.JSX.Element {
  const target = useEditor((s) => s.target);
  if (indices.length > 1) {
    return (
      <Section title={`${indices.length} things`}>
        <MoveBy kind="thing" indices={indices} />
      </Section>
    );
  }
  const index = indices[0]!;
  const t = room.things[index];
  if (!t) return <></>;
  const corner = index < 2;
  const set = (patch: Partial<SourceThing>): void => void edit((r) => ({ ...r, things: r.things.map((x, i) => (i === index ? { ...x, ...patch } : x)) }));
  const full = room.things.length > 2;
  return (
    <Section title={corner ? `Room box corner ${index + 1}` : `Thing ${index}`}>
      <div className="row">
        <NumberField label="X" value={t.x} onCommit={(x) => set({ x })} />
        <NumberField label="Y" value={t.y} onCommit={(y) => set({ y })} />
      </div>
      <KodLine room={room} x={t.x} y={t.y} />
      {corner && <p className="warn-text">The two corners set the room's size and its Kod row/col origin. Moving them shifts every exit, generator and object placed in the room's Kod.</p>}
      {!corner && (
        <>
          {target === "104" && <p className="warn-text">Server 104 rejects rooms with more than two things. Extra things are roomedit's notes for Kod placement.</p>}
          <Choice label="Type" value={t.type ?? 7} options={THING_TYPES} onChange={(v) => set({ type: v })} />
          <div className="row three">
            <Choice
              label="Angle"
              value={t.angle ?? 0}
              options={[0, 45, 90, 135, 180, 225, 270, 315].map((a) => ({ value: a, label: `${a}°` }))}
              onChange={(v) => set({ angle: v })}
            />
            <NumberField label="When / RID" value={t.when ?? 0} onCommit={(v) => set({ when: v })} title="Exits: the destination room id" />
            <NumberField label="Flags" value={t.flags ?? 0} onCommit={(v) => set({ flags: v })} title="1 = don't generate, 2 = has comment" />
          </div>
          <div className="row">
            <NumberField label="Exit X" value={t.xExit ?? 0} onCommit={(v) => set({ xExit: v })} />
            <NumberField label="Exit Y" value={t.yExit ?? 0} onCommit={(v) => set({ yExit: v })} />
          </div>
          <label className="field">
            <span>Comment</span>
            <input defaultValue={t.comment ?? ""} key={`${index}:${t.comment}`} maxLength={63} onBlur={(e) => e.target.value !== (t.comment ?? "") && set({ comment: e.target.value })} />
          </label>
        </>
      )}
      {full && corner && <p className="hint">With more than two things the room saves roomedit's full thing records.</p>}
    </Section>
  );
}

// ---------------------------------------------------------------- Kod exit

const ROTATIONS = ["ROTATE_NONE", "ROTATE_90", "ROTATE_180", "ROTATE_270"];

/** A plExits entry of the room's class: a locked door or an exit. Changes are held until the room is saved. */
function KodExitPanel({ index }: { index: number }): React.JSX.Element | null {
  const k = useKodRoom().room;
  const unsaved = useEditor(kodDirty);
  const e = k?.exits[index];
  if (!k || !e) return null;
  let spec: ExitSpec;
  try {
    spec = exitSpec(e);
  } catch (err) {
    if (!(err instanceof OpError)) throw err;
    return (
      <Section title="Kod exit">
        <p className="hint">{err.message}</p>
      </Section>
    );
  }
  const set = (patch: Partial<ExitSpec>): void => void changeKodExit(index, { ...spec, ...patch } as ExitSpec);
  const text = (label: string, value: string, apply: (v: string) => void, hint: string): React.JSX.Element => (
    <label className="field" title={hint}>
      <span>{label}</span>
      <input
        defaultValue={value}
        key={`${index}:${value}`}
        onBlur={(ev) => ev.target.value.trim() !== value && apply(ev.target.value.trim())}
        onKeyDown={(ev) => ev.key === "Enter" && ev.currentTarget.blur()}
      />
    </label>
  );
  return (
    <Section
      title={spec.dest === null ? "Kod locked door" : "Kod exit"}
      actions={
        <>
          <button className="small" title="Change it in a dialog (Enter, or double-click it)" onClick={() => runCommand("kod.editExit")}>
            Edit…
          </button>
          <button className="small danger" title="Remove it from the class (Del)" onClick={() => runCommand("kod.deleteExit")}>
            Delete
          </button>
        </>
      }
    >
      <p className="hint">
        {k.className}, {baseName(k.path)} line {e.line}
        {unsaved && " · unsaved: Save writes the Kod"}
      </p>
      <Choice
        label="What it is"
        value={spec.dest === null ? "locked" : "exit"}
        options={[
          { value: "locked", label: "Locked door" },
          { value: "exit", label: "Exit to another room" },
        ]}
        onChange={(v) => {
          if (v === "locked") set({ dest: null, message: undefined });
          else runCommand("kod.editExit");
        }}
      />
      <div className="row">
        <NumberField label="Row" value={spec.row} min={1} onCommit={(row) => set({ row })} title="Kod row, from 1 at the room box's top" />
        <NumberField label="Column" value={spec.col} min={1} onCommit={(col) => set({ col })} title="Kod column, from 1 at the room box's left" />
      </div>
      {spec.dest === null ? (
        text("Message", spec.message ?? "", (message) => set({ message: message || undefined }), "A resource name from the class (marion_gate_warning); empty for the server's \"the door is locked\"")
      ) : (
        <>
          {text("To room", spec.dest, (dest) => set({ dest }), "An RID_ constant from blakston.khd, or a room number")}
          <div className="row three">
            <NumberField label="At row" value={spec.destRow} min={1} onCommit={(destRow) => set({ destRow })} title="Where players arrive in that room" />
            <NumberField label="At column" value={spec.destCol} min={1} onCommit={(destCol) => set({ destCol })} />
            <Choice label="Turn" value={spec.rotate ?? "ROTATE_NONE"} options={[...new Set([...ROTATIONS, spec.rotate ?? "ROTATE_NONE"])].map((r) => ({ value: r, label: r.replace(/^ROTATE_/, "") }))} onChange={(rotate) => set({ rotate })} />
          </div>
        </>
      )}
      <p className="hint">Drag the square on the map to move it. Saving the room writes the .kod; for Shards' rooms it then builds and reloads the Kod, after asking.</p>
    </Section>
  );
}

// ---------------------------------------------------------------- bits

function KodLine({ room, x, y }: { room: RoomSource; x: number; y: number }): React.JSX.Element | null {
  const k = kodCoords(room, x, y);
  if (!k) return null;
  return (
    <p className="hint">
      Kod: row {k.row}, col {k.col} (fine {k.fineRow}, {k.fineCol})
    </p>
  );
}

function ItemLink({ kind, index, label }: { kind: ItemKind; index: number; label?: string }): React.JSX.Element {
  return (
    <button className="link" onClick={() => selectOne({ kind, index })}>
      {label ?? `#${index}`}
    </button>
  );
}
