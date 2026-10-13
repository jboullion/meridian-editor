// Walk mode: where the walker is (for the map to show), and requests to start
// walking. The 3D preview owns the Walker and does the moving.

import { useSyncExternalStore } from "react";
import { editor, Store } from "../store.ts";

interface WalkState {
  active: boolean;
  /** Client fine units from the room box's top-left corner (x east, y south); angle 0..4095. */
  x: number;
  y: number;
  /** Floor under the walker, client units (16 per editor unit). */
  z: number;
  angle: number;
  /** Where to start; null for the Kod arrival square, or somewhere in the room. */
  start: { x: number; y: number } | null;
  /** Bumped by each start request. */
  startSeq: number;
}

export const walk = new Store<WalkState>({ active: false, x: 0, y: 0, z: 0, angle: 0, start: null, startSeq: 0 });
export const useWalk = <R,>(select: (s: WalkState) => R): R => useSyncExternalStore(walk.subscribe, () => select(walk.get()));

/** Start walking at a spot (client units), or at the room's arrival square. Shows the 3D view if it's hidden. */
export function startWalk(at?: { x: number; y: number }): void {
  walk.set((s) => ({ active: true, start: at ?? null, startSeq: s.startSeq + 1 }));
  if (editor.get().view === "2d") editor.set({ view: "split" });
}

export function stopWalk(): void {
  walk.set({ active: false });
}

/** An editor point as client units, from the room box (things 0 and 1). */
export function editorToClient(things: readonly { x: number; y: number }[], x: number, y: number): { x: number; y: number } | null {
  const [t0, t1] = things;
  if (!t0 || !t1) return null;
  return { x: (x - Math.min(t0.x, t1.x)) * 16, y: (Math.max(t0.y, t1.y) - y) * 16 };
}

/** A client point as editor units. */
export function clientToEditor(things: readonly { x: number; y: number }[], x: number, y: number): [number, number] | null {
  const [t0, t1] = things;
  if (!t0 || !t1) return null;
  return [Math.min(t0.x, t1.x) + x / 16, Math.max(t0.y, t1.y) - y / 16];
}
