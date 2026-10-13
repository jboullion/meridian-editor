// The 2D map. Grid, sector fills (from the compiled BSP), linedefs, vertices,
// things, and where the room's Kod puts things (read-only); plus the editing tools:
//   select     click / shift-click / box-drag to select in the current mode,
//              drag the selection to move it, right-click for operations
//   draw       click points; click the first point to close a sector, double-
//              click or Enter to finish an open line, Backspace to undo a point
//   rectangle, polygon, circle   drag out a shape
//   torch, thing                 click to place
// Wheel zooms; middle-drag or Space+drag pans.

import { useEffect, useRef } from "react";
import type { RoomSource } from "@meridian-editor/roomc";
import { openContextMenu } from "./ContextMenu.tsx";
import { compiled } from "./compiler.ts";
import { distanceToSegment, roomBounds, sectorAt, sectorPieces, type SectorPiece } from "./geometry.ts";
import { dlightScale, isHighlight, lightColor } from "./kod/kodLights.ts";
import { kodToEditor, type KodRoom } from "./kod/kodRooms.ts";
import { currentKodRoom, kod, kodMarks, roomBox, roomLights } from "./kod/kodStore.ts";
import { clientToEditor, walk } from "./preview/walkStore.ts";
import { insertPath } from "./ops/draw.ts";
import { addThing, autoMerge, moveItems, verticesOf } from "./ops/edit.ts";
import { nearestOnSegment, sectorAtPoint, type Pt } from "./ops/geom.ts";
import { circleSides, insertShape, insertTorch, polygonPoints, rectanglePoints } from "./ops/shapes.ts";
import {
  beginGesture,
  cursor,
  edit,
  editor,
  endGesture,
  isSelected,
  notify,
  previewEdit,
  select,
  selectOne,
  toggleSelected,
  type EditorState,
  type ItemKind,
  type ItemRef,
  type Selection,
} from "./store.ts";

interface View {
  /** Editor coordinates at the canvas centre. */
  cx: number;
  cy: number;
  /** Pixels per editor unit. */
  scale: number;
}

const COLORS = {
  background: "#14161b",
  gridMinor: "rgba(255,255,255,0.045)",
  gridMajor: "rgba(255,255,255,0.10)",
  oneSided: "#e6e8ee",
  twoSided: "#7d8494",
  passable: "#5a9f7a",
  noSides: "#d05a5a",
  selected: "#ffb347",
  hover: "#7cc4ff",
  vertex: "#b9c0cf",
  roomBox: "rgba(255, 210, 120, 0.55)",
  thing: "#ffcc66",
  draw: "#9be38a",
  box: "rgba(124, 196, 255, 0.9)",
};

type Interaction =
  | { mode: "idle" }
  | { mode: "pan"; sx: number; sy: number; cx: number; cy: number }
  | { mode: "press"; sx: number; sy: number; wx: number; wy: number; hit: ItemRef | null; additive: boolean }
  | { mode: "move"; wx: number; wy: number; sel: Selection; dx: number; dy: number }
  | { mode: "box"; x0: number; y0: number; x1: number; y1: number; additive: boolean }
  | { mode: "shape"; x0: number; y0: number; x1: number; y1: number };

export function MapView(): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext("2d")!;
    const view: View = { cx: 0, cy: 0, scale: 0.5 };
    let frame = 0;
    let spaceDown = false;
    let act: Interaction = { mode: "idle" };
    /** Points of the line being drawn, and where the next one would go. */
    let drawing: Pt[] = [];
    let snapAt: { p: Pt; kind: "vertex" | "line" | "grid" | "free" } | null = null;
    let seenSeq = -1;

    const size = (): { w: number; h: number } => ({ w: canvas.clientWidth, h: canvas.clientHeight });
    const toWorld = (px: number, py: number): [number, number] => {
      const { w, h } = size();
      return [view.cx + (px - w / 2) / view.scale, view.cy - (py - h / 2) / view.scale];
    };
    const sx = (x: number): number => (x - view.cx) * view.scale + size().w / 2;
    const sy = (y: number): number => (view.cy - y) * view.scale + size().h / 2;

    const fit = (room: RoomSource): void => {
      const b = roomBounds(room);
      const { w, h } = size();
      const pad = 40;
      const scale = Math.min((w - pad * 2) / Math.max(64, b.maxX - b.minX), (h - pad * 2) / Math.max(64, b.maxY - b.minY));
      Object.assign(view, { cx: (b.minX + b.maxX) / 2, cy: (b.minY + b.maxY) / 2, scale: Math.max(0.01, Math.min(8, scale)) });
    };

    const request = (): void => {
      if (!frame) frame = requestAnimationFrame(draw);
    };

    const pieces = (): SectorPiece[] | null => {
      const c = compiled.get();
      return c.result ? sectorPieces(c.result.file, c.result.origin) : null;
    };

    // ------------------------------------------------------------- snapping and picking

    /** Where a drawn point lands: an existing vertex, a point on a wall, the grid, or free. */
    const snapPoint = (x: number, y: number): { p: Pt; kind: "vertex" | "line" | "grid" | "free" } => {
      const { room, grid, snap } = editor.get();
      const tol = 8 / view.scale;
      if (room) {
        let best = -1;
        let bestD = tol;
        room.vertices.forEach(([vx, vy], i) => {
          const d = Math.hypot(vx - x, vy - y);
          if (d < bestD) {
            bestD = d;
            best = i;
          }
        });
        if (best >= 0) return { p: room.vertices[best]!, kind: "vertex" };
        for (const p of drawing) if (Math.hypot(p[0] - x, p[1] - y) < tol) return { p, kind: "vertex" };
      }
      const g = snap ? [Math.round(x / grid) * grid, Math.round(y / grid) * grid] : [Math.round(x), Math.round(y)];
      if (room) {
        const lineTol = 6 / view.scale;
        let bestLine: { a: Pt; b: Pt; d: number } | null = null;
        for (const l of room.linedefs) {
          const a = room.vertices[l.start]!;
          const b = room.vertices[l.end]!;
          const d = distanceToSegment(x, y, a[0], a[1], b[0], b[1]);
          if (d < lineTol && (!bestLine || d < bestLine.d)) bestLine = { a, b, d };
        }
        if (bestLine) {
          const near = nearestOnSegment([g[0]!, g[1]!], bestLine.a, bestLine.b);
          return { p: [Math.round(near.x), Math.round(near.y)], kind: "line" };
        }
      }
      return { p: [g[0]!, g[1]!], kind: snap ? "grid" : "free" };
    };

    const pick = (px: number, py: number): ItemRef | null => {
      const { room, mode } = editor.get();
      if (!room) return null;
      const [x, y] = toWorld(px, py);
      const tol = 6 / view.scale;
      return pickKind(room, mode, x, y, tol);
    };

    const pickKind = (room: RoomSource, kind: ItemKind, x: number, y: number, tol: number): ItemRef | null => {
      let best: ItemRef | null = null;
      let bestD = Infinity;
      if (kind === "thing") {
        room.things.forEach((t, i) => {
          const d = Math.hypot(t.x - x, t.y - y);
          if (d < tol * 1.8 && d < bestD) [best, bestD] = [{ kind, index: i }, d];
        });
      } else if (kind === "vertex") {
        room.vertices.forEach(([vx, vy], i) => {
          const d = Math.hypot(vx - x, vy - y);
          if (d < tol * 1.4 && d < bestD) [best, bestD] = [{ kind, index: i }, d];
        });
      } else if (kind === "linedef") {
        room.linedefs.forEach((l, i) => {
          const a = room.vertices[l.start];
          const b = room.vertices[l.end];
          if (!a || !b) return;
          const d = distanceToSegment(x, y, a[0], a[1], b[0], b[1]);
          if (d < tol && d < bestD) [best, bestD] = [{ kind, index: i }, d];
        });
      } else {
        const p = pieces();
        const s = (p && sectorAt(p, x, y)) ?? sectorAtPoint(room, x, y);
        if (s !== null && s < room.sectors.length) best = { kind, index: s };
      }
      return best;
    };

    const inBox = (room: RoomSource, kind: ItemKind, x0: number, y0: number, x1: number, y1: number): number[] => {
      const [l, r] = [Math.min(x0, x1), Math.max(x0, x1)];
      const [b, t] = [Math.min(y0, y1), Math.max(y0, y1)];
      const inside = (x: number, y: number): boolean => x >= l && x <= r && y >= b && y <= t;
      if (kind === "thing") return room.things.flatMap((th, i) => (inside(th.x, th.y) ? [i] : []));
      if (kind === "vertex") return room.vertices.flatMap(([x, y], i) => (inside(x, y) ? [i] : []));
      if (kind === "linedef") {
        return room.linedefs.flatMap((ld, i) => {
          const a = room.vertices[ld.start]!;
          const c = room.vertices[ld.end]!;
          return inside(a[0], a[1]) && inside(c[0], c[1]) ? [i] : [];
        });
      }
      return room.sectors.flatMap((_, s) => {
        const vs = verticesOf(room, "sector", [s]);
        return vs.length > 0 && vs.every((v) => inside(room.vertices[v]![0], room.vertices[v]![1])) ? [s] : [];
      });
    };

    // ------------------------------------------------------------- committing tool actions

    const commitDrawing = (closed: boolean): void => {
      const pts = drawing;
      drawing = [];
      if (pts.length < 2 || (closed && pts.length < 3)) return request();
      const { prefs } = editor.get();
      let made: { sectors: number[]; path: number[] } | null = null;
      edit((r) => {
        const out = insertPath(r, pts, closed, prefs.defaults);
        made = out;
        return out.room;
      });
      if (made) {
        const m = made as { sectors: number[]; path: number[] };
        if (m.sectors.length) select({ kind: "sector", indices: m.sectors });
        else select({ kind: "linedef", indices: m.path });
        notify(closed ? (m.sectors.length ? `Drew ${m.sectors.length} sector(s).` : "Closed the loop.") : `Drew ${m.path.length} linedef(s).`);
      }
      request();
    };

    const commitShape = (x0: number, y0: number, x1: number, y1: number): void => {
      const { tool, prefs } = editor.get();
      let pts: Pt[];
      if (tool === "rectangle") {
        if (Math.abs(x1 - x0) < 8 || Math.abs(y1 - y0) < 8) return notify("Drag out a rectangle at least 8 units each way.", "error");
        pts = rectanglePoints(x0, y0, x1, y1);
      } else {
        const r = Math.round(Math.hypot(x1 - x0, y1 - y0));
        if (r < 8) return notify("Drag out a radius of at least 8 units.", "error");
        pts = polygonPoints(x0, y0, tool === "circle" ? circleSides(r) : prefs.polygonSides, r);
      }
      let sectors: number[] = [];
      let path: number[] = [];
      const ok = edit((room) => {
        const out = insertShape(room, pts, prefs.defaults, prefs.pillar);
        sectors = out.sectors;
        path = out.path;
        return out.room;
      });
      if (ok) select(sectors.length ? { kind: "sector", indices: sectors } : { kind: "linedef", indices: path });
    };

    // ------------------------------------------------------------- drawing

    function draw(): void {
      frame = 0;
      const dpr = window.devicePixelRatio || 1;
      const { w, h } = size();
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = COLORS.background;
      ctx.fillRect(0, 0, w, h);

      const state = editor.get();
      const room = state.room;
      // Nothing to frame until the canvas has a size; a fit now would be wrong.
      if (!room || w === 0 || h === 0) return;
      if (state.viewSeq !== seenSeq) {
        seenSeq = state.viewSeq;
        const r = state.viewRequest;
        if (r?.kind === "fit") fit(room);
        else if (r?.kind === "center") Object.assign(view, { cx: r.x, cy: r.y, scale: Math.max(view.scale, 0.6) });
        else if (r?.kind === "zoom") view.scale = Math.min(40, Math.max(0.01, view.scale * r.factor));
      }

      if (state.showGrid) drawGrid(ctx, view, w, h, state.grid);

      const c = compiled.get();
      const p = pieces();
      if (p && c.room) drawSectors(ctx, p, c.room, state, sx, sy);

      const [t0, t1] = room.things;
      if (t0 && t1) {
        ctx.save();
        ctx.setLineDash([6, 4]);
        ctx.strokeStyle = COLORS.roomBox;
        ctx.lineWidth = 1;
        ctx.strokeRect(sx(Math.min(t0.x, t1.x)), sy(Math.max(t0.y, t1.y)), Math.abs(t1.x - t0.x) * view.scale, Math.abs(t1.y - t0.y) * view.scale);
        ctx.restore();
      }

      drawLinedefs(ctx, room, state, view, sx, sy);

      // Vertices: always in vertex mode, otherwise only when zoomed in.
      const vertexMode = state.mode === "vertex";
      if (vertexMode || view.scale > 0.35) {
        ctx.fillStyle = COLORS.vertex;
        const r = vertexMode ? 2.5 : view.scale > 1.5 ? 2 : 1.25;
        for (const [x, y] of room.vertices) ctx.fillRect(sx(x) - r, sy(y) - r, r * 2, r * 2);
      }
      const markVertex = (i: number, color: string): void => {
        const v = room.vertices[i];
        if (!v) return;
        ctx.fillStyle = color;
        ctx.fillRect(sx(v[0]) - 4, sy(v[1]) - 4, 8, 8);
      };
      if (state.hover?.kind === "vertex") markVertex(state.hover.index, COLORS.hover);
      if (state.selection?.kind === "vertex") state.selection.indices.forEach((i, n) => {
        markVertex(i, COLORS.selected);
        if (state.selection!.indices.length > 1) label(ctx, String(n + 1), sx(room.vertices[i]![0]) + 6, sy(room.vertices[i]![1]) - 6);
      });

      room.things.forEach((t, i) => {
        const active = isSelected(state.selection, { kind: "thing", index: i });
        const hover = state.hover?.kind === "thing" && state.hover.index === i;
        ctx.beginPath();
        ctx.arc(sx(t.x), sy(t.y), active ? 7 : 5, 0, Math.PI * 2);
        ctx.fillStyle = active ? COLORS.selected : hover ? COLORS.hover : COLORS.thing;
        ctx.globalAlpha = state.mode === "thing" || i < 2 ? 1 : 0.6;
        ctx.fill();
        ctx.globalAlpha = 1;
        label(ctx, i < 2 ? `box ${i + 1}` : `thing ${i}`, sx(t.x) + 9, sy(t.y) - 7);
      });

      if (kod.get().show) {
        const k = currentKodRoom().room;
        const box = roomBox(room.things);
        if (k && box && t0 && t1) drawKod(ctx, k, { ...box, right: Math.max(t0.x, t1.x), bottom: Math.min(t0.y, t1.y) }, view, sx, sy);
      }

      // The walker, in walk mode: a dot with the way it faces.
      const walker = walk.get();
      const at = walker.active ? clientToEditor(room.things, walker.x, walker.y) : null;
      if (at) {
        const a = (walker.angle * 2 * Math.PI) / 4096;
        // Client y runs south, the same way as the screen's.
        const [dx, dy] = [Math.cos(a), Math.sin(a)];
        const [px, py] = [sx(at[0]), sy(at[1])];
        ctx.save();
        ctx.fillStyle = COLORS.selected;
        ctx.strokeStyle = "rgba(0,0,0,0.8)";
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(px + dx * 12, py + dy * 12);
        ctx.lineTo(px - dx * 6 - dy * 7, py - dy * 6 + dx * 7);
        ctx.lineTo(px - dx * 6 + dy * 7, py - dy * 6 - dx * 7);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        ctx.restore();
      }

      // Tool overlays.
      if (act.mode === "box") {
        ctx.save();
        ctx.setLineDash([4, 3]);
        ctx.strokeStyle = COLORS.box;
        ctx.fillStyle = "rgba(124,196,255,0.08)";
        const x = sx(Math.min(act.x0, act.x1));
        const y = sy(Math.max(act.y0, act.y1));
        const bw = Math.abs(act.x1 - act.x0) * view.scale;
        const bh = Math.abs(act.y1 - act.y0) * view.scale;
        ctx.fillRect(x, y, bw, bh);
        ctx.strokeRect(x, y, bw, bh);
        ctx.restore();
      }
      if (drawing.length || (state.tool !== "select" && snapAt)) {
        const pts = [...drawing, ...(snapAt && state.tool === "draw" ? [snapAt.p] : [])];
        if (state.tool === "draw" && pts.length) {
          ctx.strokeStyle = COLORS.draw;
          ctx.lineWidth = 2;
          ctx.beginPath();
          pts.forEach((q, i) => (i ? ctx.lineTo(sx(q[0]), sy(q[1])) : ctx.moveTo(sx(q[0]), sy(q[1]))));
          ctx.stroke();
          for (const q of drawing) {
            ctx.fillStyle = COLORS.draw;
            ctx.fillRect(sx(q[0]) - 3, sy(q[1]) - 3, 6, 6);
          }
          const last = drawing[drawing.length - 1];
          if (last && snapAt) {
            const len = Math.round(Math.hypot(snapAt.p[0] - last[0], snapAt.p[1] - last[1]));
            label(ctx, `${len}`, (sx(last[0]) + sx(snapAt.p[0])) / 2 + 6, (sy(last[1]) + sy(snapAt.p[1])) / 2 - 6);
          }
          // Closing the loop: highlight the first point.
          const first = drawing[0];
          if (first && snapAt && drawing.length > 2 && snapAt.p[0] === first[0] && snapAt.p[1] === first[1]) {
            ctx.strokeStyle = COLORS.selected;
            ctx.strokeRect(sx(first[0]) - 6, sy(first[1]) - 6, 12, 12);
          }
        }
        if (snapAt) {
          ctx.strokeStyle = snapAt.kind === "vertex" ? COLORS.selected : snapAt.kind === "line" ? COLORS.hover : COLORS.draw;
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.arc(sx(snapAt.p[0]), sy(snapAt.p[1]), 5, 0, Math.PI * 2);
          ctx.stroke();
        }
      }
      if (act.mode === "shape") {
        const { tool, prefs } = state;
        let pts: Pt[] = [];
        if (tool === "rectangle") pts = rectanglePoints(act.x0, act.y0, act.x1, act.y1);
        else {
          const r = Math.round(Math.hypot(act.x1 - act.x0, act.y1 - act.y0));
          if (r >= 1) pts = polygonPoints(act.x0, act.y0, tool === "circle" ? circleSides(r) : prefs.polygonSides, r);
          label(ctx, `r ${r}`, sx(act.x1) + 8, sy(act.y1) - 8);
        }
        if (pts.length) {
          ctx.strokeStyle = COLORS.draw;
          ctx.lineWidth = 2;
          ctx.beginPath();
          pts.forEach((q, i) => (i ? ctx.lineTo(sx(q[0]), sy(q[1])) : ctx.moveTo(sx(q[0]), sy(q[1]))));
          ctx.closePath();
          ctx.stroke();
          if (tool === "rectangle") label(ctx, `${Math.abs(act.x1 - act.x0)} × ${Math.abs(act.y1 - act.y0)}`, sx(Math.max(act.x0, act.x1)) + 8, sy(Math.min(act.y0, act.y1)) + 14);
        }
      }
    }

    // ------------------------------------------------------------- events

    const local = (e: MouseEvent | WheelEvent): [number, number] => {
      const r = canvas.getBoundingClientRect();
      return [e.clientX - r.left, e.clientY - r.top];
    };

    const onWheel = (e: WheelEvent): void => {
      e.preventDefault();
      const [px, py] = local(e);
      const [wx, wy] = toWorld(px, py);
      view.scale = Math.min(40, Math.max(0.01, view.scale * Math.pow(1.0015, -e.deltaY)));
      const [nx, ny] = toWorld(px, py);
      view.cx += wx - nx;
      view.cy += wy - ny;
      request();
    };

    const onDown = (e: MouseEvent): void => {
      canvas.focus();
      const [px, py] = local(e);
      const [wx, wy] = toWorld(px, py);
      const state = editor.get();
      if (e.button === 1 || (e.button === 0 && spaceDown)) {
        e.preventDefault();
        act = { mode: "pan", sx: px, sy: py, cx: view.cx, cy: view.cy };
        return;
      }
      if (e.button === 2) {
        // Right-click: select what's under the cursor (unless it's already selected) and offer operations.
        const hit = pick(px, py);
        if (hit && !isSelected(state.selection, hit)) selectOne(hit);
        openContextMenu(e.clientX, e.clientY);
        return;
      }
      if (e.button !== 0 || !state.room) return;

      switch (state.tool) {
        case "draw": {
          const s = snapPoint(wx, wy);
          const first = drawing[0];
          if (first && drawing.length > 2 && s.p[0] === first[0] && s.p[1] === first[1]) commitDrawing(true);
          else if (e.detail >= 2 && drawing.length >= 1) {
            // Double-click: the first click of the pair already added this point.
            commitDrawing(false);
          } else {
            const last = drawing[drawing.length - 1];
            if (!last || last[0] !== s.p[0] || last[1] !== s.p[1]) drawing.push(s.p);
          }
          request();
          return;
        }
        case "rectangle":
        case "polygon":
        case "circle": {
          const s = snapPoint(wx, wy);
          act = { mode: "shape", x0: s.p[0], y0: s.p[1], x1: s.p[0], y1: s.p[1] };
          return;
        }
        case "torch": {
          const { torchAngle } = state.prefs;
          let anchor: Pt | null = null;
          if (
            edit((r) => {
              const out = insertTorch(r, wx, wy, torchAngle);
              anchor = out.anchor;
              return out.room;
            }) &&
            anchor
          ) {
            notify(`Torch placed at (${(anchor as Pt)[0]}, ${(anchor as Pt)[1]}).`);
          }
          return;
        }
        case "thing": {
          const s = snapPoint(wx, wy);
          const copyFrom = state.selection?.kind === "thing" ? state.selection.indices[0] : undefined;
          if (edit((r) => addThing(r, s.p[0], s.p[1], copyFrom !== undefined && copyFrom >= 2 ? copyFrom : undefined))) {
            selectOne({ kind: "thing", index: editor.get().room!.things.length - 1 });
            if (state.target === "104") notify("Server 104 only loads rooms with exactly two things; extra things are editor notes for the original server.");
          }
          return;
        }
        default: {
          const hit = pick(px, py);
          const additive = e.shiftKey || e.ctrlKey || e.metaKey;
          if (hit && additive) {
            toggleSelected(hit);
            act = { mode: "idle" };
            return;
          }
          if (hit && !isSelected(state.selection, hit)) selectOne(hit);
          act = { mode: "press", sx: px, sy: py, wx, wy, hit, additive };
        }
      }
    };

    const onMove = (e: MouseEvent): void => {
      const [px, py] = local(e);
      const [x, y] = toWorld(px, py);
      const inside = e.target === canvas || act.mode !== "idle";
      if (inside) cursor.set({ x, y, inside: e.target === canvas });
      const state = editor.get();
      switch (act.mode) {
        case "pan":
          view.cx = act.cx - (px - act.sx) / view.scale;
          view.cy = act.cy + (py - act.sy) / view.scale;
          return request();
        case "press": {
          if (Math.hypot(px - act.sx, py - act.sy) < 4) return;
          const sel = editor.get().selection;
          if (act.hit && sel) {
            beginGesture();
            act = { mode: "move", wx: act.wx, wy: act.wy, sel, dx: 0, dy: 0 };
          } else {
            if (!act.additive) select(null);
            act = { mode: "box", x0: act.wx, y0: act.wy, x1: x, y1: y, additive: act.additive };
          }
          return request();
        }
        case "move": {
          const step = state.snap ? state.grid : 1;
          const dx = Math.round((x - act.wx) / step) * step;
          const dy = Math.round((y - act.wy) / step) * step;
          const sel = act.sel;
          act.dx = dx;
          act.dy = dy;
          previewEdit((room) => moveItems(room, sel.kind, sel.indices, dx, dy));
          return;
        }
        case "box":
          act.x1 = x;
          act.y1 = y;
          return request();
        case "shape": {
          const s = snapPoint(x, y);
          act.x1 = s.p[0];
          act.y1 = s.p[1];
          snapAt = s;
          return request();
        }
      }
      if (e.target !== canvas) return;
      if (state.tool !== "select") {
        snapAt = state.tool === "torch" ? { p: [Math.round(x), Math.round(y)], kind: "free" } : snapPoint(x, y);
        return request();
      }
      snapAt = null;
      const hover = pick(px, py);
      const prev = state.hover;
      if (hover?.kind !== prev?.kind || hover?.index !== prev?.index) editor.set({ hover });
    };

    const onUp = (e: MouseEvent): void => {
      const state = editor.get();
      if (act.mode === "move") {
        // roomedit's AutoMergeVertices: dropped on a vertex merges, on a wall splits it.
        const { sel, dx, dy } = act;
        if (sel.kind !== "thing" && (dx || dy)) {
          previewEdit((room) => {
            const moved = moveItems(room, sel.kind, sel.indices, dx, dy);
            const verts = verticesOf(room, sel.kind, sel.indices).map((v) => moved.vertices[v]!);
            return autoMerge(moved, verts);
          });
        }
        endGesture();
      }
      else if (act.mode === "box" && state.room) {
        const found = inBox(state.room, state.mode, act.x0, act.y0, act.x1, act.y1);
        const prev = act.additive && state.selection?.kind === state.mode ? state.selection.indices : [];
        select({ kind: state.mode, indices: [...new Set([...prev, ...found])] });
      } else if (act.mode === "press" && !act.hit && !act.additive && e.button === 0) select(null);
      else if (act.mode === "shape") commitShape(act.x0, act.y0, act.x1, act.y1);
      act = { mode: "idle" };
      request();
    };

    const onLeave = (): void => {
      cursor.set({ inside: false });
      snapAt = null;
      if (editor.get().hover) editor.set({ hover: null });
      request();
    };

    // Keys the map handles itself while a line is being drawn (before the command shortcuts).
    const onKeyCapture = (e: KeyboardEvent): void => {
      if (e.code === "Space" && document.activeElement === canvas) spaceDown = e.type === "keydown";
      if (e.type !== "keydown" || drawing.length === 0) return;
      if (e.key === "Enter") commitDrawing(false);
      else if (e.key === "Backspace") drawing.pop();
      else if (e.key === "Escape") drawing = [];
      else return;
      e.preventDefault();
      e.stopPropagation();
      request();
    };

    const onContext = (e: MouseEvent): void => e.preventDefault();
    const resize = new ResizeObserver(request);
    resize.observe(canvas);
    let lastTool = editor.get().tool;
    const unsubEditor = editor.subscribe(() => {
      const tool = editor.get().tool;
      if (tool !== lastTool) {
        // Switching tools drops a half-drawn line.
        lastTool = tool;
        drawing = [];
        snapAt = null;
        canvas.style.cursor = tool === "select" ? "default" : "crosshair";
      }
      request();
    });
    const unsubCompiled = compiled.subscribe(request);
    const unsubKod = kod.subscribe(request);
    const unsubWalk = walk.subscribe(request);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    canvas.addEventListener("mousedown", onDown);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    canvas.addEventListener("mouseleave", onLeave);
    canvas.addEventListener("contextmenu", onContext);
    window.addEventListener("keydown", onKeyCapture, true);
    window.addEventListener("keyup", onKeyCapture, true);
    canvas.style.cursor = editor.get().tool === "select" ? "default" : "crosshair";
    request();
    // Development only: world <-> client coordinates, for tests that drive the map.
    if (import.meta.env.DEV) {
      Object.assign(window, {
        __map: {
          toClient: (x: number, y: number): [number, number] => {
            const r = canvas.getBoundingClientRect();
            return [r.left + sx(x), r.top + sy(y)];
          },
          view,
        },
      });
    }
    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect();
      unsubEditor();
      unsubCompiled();
      unsubKod();
      unsubWalk();
      canvas.removeEventListener("wheel", onWheel);
      canvas.removeEventListener("mousedown", onDown);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      canvas.removeEventListener("mouseleave", onLeave);
      canvas.removeEventListener("contextmenu", onContext);
      window.removeEventListener("keydown", onKeyCapture, true);
      window.removeEventListener("keyup", onKeyCapture, true);
    };
  }, []);

  return <canvas ref={canvasRef} className="map-canvas" tabIndex={0} aria-label="Room map" />;
}

function label(ctx: CanvasRenderingContext2D, text: string, x: number, y: number): void {
  ctx.font = "11px system-ui, sans-serif";
  ctx.fillStyle = "rgba(0,0,0,0.6)";
  const w = ctx.measureText(text).width;
  ctx.fillRect(x - 2, y - 10, w + 4, 13);
  ctx.fillStyle = "rgba(255,255,255,0.9)";
  ctx.fillText(text, x, y);
}

const KOD_COLORS = {
  exit: "rgba(90, 220, 120, 0.95)",
  locked: "rgba(240, 90, 90, 0.95)",
  generator: "rgba(255, 150, 60, 0.95)",
  object: "rgba(110, 170, 255, 0.95)",
  sound: "rgba(200, 130, 255, 0.95)",
  arrival: "rgba(255, 230, 90, 0.95)",
};

/** The room's Kod placements: exits fill their square, the rest are marks at their exact spot. */
function drawKod(
  ctx: CanvasRenderingContext2D,
  k: KodRoom,
  box: { left: number; top: number; right: number; bottom: number },
  v: View,
  sx: (x: number) => number,
  sy: (y: number) => number,
): void {
  const s = 64 * v.scale;
  ctx.save();
  ctx.lineWidth = 1.5;
  for (const e of k.exits) {
    const color = e.dest === null ? KOD_COLORS.locked : KOD_COLORS.exit;
    const x = sx(box.left + (e.col - 1) * 64);
    const y = sy(box.top - (e.row - 1) * 64);
    ctx.fillStyle = color.replace("0.95", "0.22");
    ctx.fillRect(x, y, s, s);
    ctx.strokeStyle = color;
    ctx.strokeRect(x, y, s, s);
    if (e.dest === null && s > 10) {
      ctx.beginPath();
      ctx.moveTo(x + 3, y + 3);
      ctx.lineTo(x + s - 3, y + s - 3);
      ctx.moveTo(x + s - 3, y + 3);
      ctx.lineTo(x + 3, y + s - 3);
      ctx.stroke();
    }
  }
  // Edge exits: a dashed bar just outside that side of the room box.
  ctx.save();
  ctx.strokeStyle = KOD_COLORS.exit;
  ctx.lineWidth = 4;
  ctx.setLineDash([10, 6]);
  for (const e of k.edgeExits) {
    const [l, r, t, b] = [sx(box.left), sx(box.right), sy(box.top), sy(box.bottom)];
    const [x0, y0, x1, y1, lx, ly] =
      e.side === "north" ? [l, t - 5, r, t - 5, l, t - 10]
      : e.side === "south" ? [l, b + 5, r, b + 5, l, b + 18]
      : e.side === "west" ? [l - 5, t, l - 5, b, l + 4, t + 14]
      : [r + 5, t, r + 5, b, r - 140, t + 14];
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.stroke();
    label(ctx, `${e.side} edge to ${e.dest}${e.destRow !== undefined ? ` (${e.destRow}, ${e.destCol})` : ""}`, lx, ly);
  }
  ctx.restore();
  // How far each light reaches (DLIGHT_SCALE / 2; client units are 16 an editor unit), at the 3D view's hour.
  ctx.save();
  ctx.setLineDash([3, 4]);
  ctx.lineWidth = 1;
  for (const { object: o, light } of roomLights(editor.get().light.hour)) {
    const [x, y] = kodToEditor(box, o);
    const c = lightColor(light.color);
    const reach = (dlightScale(light.intensity) * (isHighlight(light.flags) ? 0.1 : 1)) / 2 / 16;
    ctx.strokeStyle = `rgba(${c.r}, ${c.g}, ${c.b}, 0.7)`;
    ctx.fillStyle = `rgba(${c.r}, ${c.g}, ${c.b}, 0.06)`;
    ctx.beginPath();
    ctx.arc(sx(x), sy(y), reach * v.scale, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
  ctx.restore();
  for (const m of kodMarks(k, box)) {
    if (m.kind === "exit" || m.kind === "locked") continue;
    const x = sx(m.x);
    const y = sy(m.y);
    ctx.fillStyle = KOD_COLORS[m.kind];
    ctx.strokeStyle = "rgba(0,0,0,0.7)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    if (m.kind === "object") {
      ctx.moveTo(x, y - 4);
      ctx.lineTo(x + 4, y);
      ctx.lineTo(x, y + 4);
      ctx.lineTo(x - 4, y);
      ctx.closePath();
    } else if (m.kind === "arrival") {
      for (let i = 0; i < 10; i++) {
        const r = i % 2 ? 3 : 7;
        const a = (i * Math.PI) / 5 - Math.PI / 2;
        if (i) ctx.lineTo(x + r * Math.cos(a), y + r * Math.sin(a));
        else ctx.moveTo(x + r * Math.cos(a), y + r * Math.sin(a));
      }
      ctx.closePath();
    } else ctx.arc(x, y, m.kind === "generator" ? 5 : 3.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
  // Labels once there's room for them.
  if (v.scale > 0.9) {
    for (const m of kodMarks(k, box)) {
      if (m.kind === "exit" || m.kind === "locked") label(ctx, m.label, sx(box.left + (m.col - 1) * 64) + 2, sy(box.top - (m.row - 1) * 64) + 12);
      else if (m.kind !== "object" || v.scale > 1.6) label(ctx, m.label, sx(m.x) + 7, sy(m.y) + 4);
    }
  }
  ctx.restore();
}

function drawGrid(ctx: CanvasRenderingContext2D, v: View, w: number, h: number, grid: number): void {
  const left = v.cx - w / 2 / v.scale;
  const right = v.cx + w / 2 / v.scale;
  const bottom = v.cy - h / 2 / v.scale;
  const top = v.cy + h / 2 / v.scale;
  const lines = (stepSize: number, color: string): void => {
    if (stepSize * v.scale < 6) return;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = Math.ceil(left / stepSize) * stepSize; x <= right; x += stepSize) {
      const px = Math.round((x - v.cx) * v.scale + w / 2) + 0.5;
      ctx.moveTo(px, 0);
      ctx.lineTo(px, h);
    }
    for (let y = Math.ceil(bottom / stepSize) * stepSize; y <= top; y += stepSize) {
      const py = Math.round((v.cy - y) * v.scale + h / 2) + 0.5;
      ctx.moveTo(0, py);
      ctx.lineTo(w, py);
    }
    ctx.stroke();
  };
  lines(grid, COLORS.gridMinor);
  // One Kod square = 64 editor units.
  lines(64, COLORS.gridMajor);
}

function drawSectors(
  ctx: CanvasRenderingContext2D,
  pieces: readonly SectorPiece[],
  room: RoomSource,
  state: EditorState,
  sx: (x: number) => number,
  sy: (y: number) => number,
): void {
  const values = room.sectors.map((s) => (state.colorBy === "light" ? s.light : state.colorBy === "ceiling" ? s.ceilingHeight : s.floorHeight));
  let min = Infinity;
  let max = -Infinity;
  for (const v of values) {
    min = Math.min(min, v);
    max = Math.max(max, v);
  }
  const span = max - min || 1;
  const selected = state.selection?.kind === "sector" ? new Set(state.selection.indices) : null;
  const hovered = state.hover?.kind === "sector" ? state.hover.index : -1;
  const sectorMode = state.mode === "sector";

  for (const p of pieces) {
    const t = ((values[p.sector] ?? min) - min) / span;
    if (selected?.has(p.sector)) ctx.fillStyle = "rgba(255, 179, 71, 0.45)";
    else if (p.sector === hovered) ctx.fillStyle = "rgba(124, 196, 255, 0.28)";
    else ctx.fillStyle = `hsla(${215 - t * 175}, 45%, ${16 + t * 22}%, ${sectorMode ? 0.95 : 0.7})`;
    ctx.beginPath();
    const pts = p.points;
    ctx.moveTo(sx(pts[0]!), sy(pts[1]!));
    for (let i = 2; i < pts.length; i += 2) ctx.lineTo(sx(pts[i]!), sy(pts[i + 1]!));
    ctx.closePath();
    ctx.fill();
  }
}

function drawLinedefs(ctx: CanvasRenderingContext2D, room: RoomSource, state: EditorState, v: View, sx: (x: number) => number, sy: (y: number) => number): void {
  const batches = new Map<string, Path2D>();
  const path = (color: string): Path2D => {
    let p = batches.get(color);
    if (!p) batches.set(color, (p = new Path2D()));
    return p;
  };
  const ticks = state.mode === "linedef" && v.scale > 0.5;
  const tickPath = new Path2D();
  room.linedefs.forEach((l) => {
    const a = room.vertices[l.start];
    const b = room.vertices[l.end];
    if (!a || !b) return;
    const twoSided = l.front && l.back;
    const passable = twoSided && (l.front!.flags & 0x4) !== 0;
    const p = path(!l.front && !l.back ? COLORS.noSides : !twoSided ? COLORS.oneSided : passable ? COLORS.passable : COLORS.twoSided);
    p.moveTo(sx(a[0]), sy(a[1]));
    p.lineTo(sx(b[0]), sy(b[1]));
    if (ticks) addTick(tickPath, sx(a[0]), sy(a[1]), sx(b[0]), sy(b[1]), 5);
  });
  ctx.lineWidth = v.scale > 1 ? 1.5 : 1;
  for (const [color, p] of batches) {
    ctx.strokeStyle = color;
    ctx.stroke(p);
  }
  if (ticks) {
    ctx.strokeStyle = "rgba(230,232,238,0.55)";
    ctx.stroke(tickPath);
  }

  const highlight = (index: number, color: string, width: number, tick: boolean): void => {
    const l = room.linedefs[index];
    const a = l && room.vertices[l.start];
    const b = l && room.vertices[l.end];
    if (!a || !b) return;
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    const p = new Path2D();
    p.moveTo(sx(a[0]), sy(a[1]));
    p.lineTo(sx(b[0]), sy(b[1]));
    if (tick) addTick(p, sx(a[0]), sy(a[1]), sx(b[0]), sy(b[1]), 10);
    ctx.stroke(p);
  };
  if (state.hover?.kind === "linedef") highlight(state.hover.index, COLORS.hover, 3, true);
  if (state.selection?.kind === "sector") {
    const set = new Set(state.selection.indices);
    room.linedefs.forEach((l, i) => {
      if ((l.front && set.has(l.front.sector)) || (l.back && set.has(l.back.sector))) highlight(i, COLORS.selected, 2, false);
    });
  }
  if (state.selection?.kind === "linedef") {
    const many = state.selection.indices.length > 1;
    state.selection.indices.forEach((i, n) => {
      highlight(i, COLORS.selected, 3, true);
      const l = room.linedefs[i];
      if (many && l) {
        const a = room.vertices[l.start]!;
        const b = room.vertices[l.end]!;
        label(ctx, String(n + 1), (sx(a[0]) + sx(b[0])) / 2 + 6, (sy(a[1]) + sy(b[1])) / 2 - 6);
      }
    });
  }
}

/** A short line from the middle of a→b towards its front (+) side, which is on the right going start → end. */
function addTick(p: Path2D, ax: number, ay: number, bx: number, by: number, length: number): void {
  const mx = (ax + bx) / 2;
  const my = (ay + by) / 2;
  const dx = bx - ax;
  const dy = by - ay;
  const len = Math.hypot(dx, dy) || 1;
  // Screen y runs down, so the right-hand normal of (dx, dy) is (-dy, dx).
  p.moveTo(mx, my);
  p.lineTo(mx - (dy / len) * length, my + (dx / len) * length);
}
