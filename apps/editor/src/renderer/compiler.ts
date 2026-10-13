// Keeps a compiled copy of the open room up to date: every change is compiled
// in a worker shortly after it lands. The map's sector fills, the 3D preview
// and the diagnostics all come from the latest result.

import { useEffect, useSyncExternalStore } from "react";
import type { RooFile, TargetName } from "@meridian-editor/roo";
import type { Diagnostic, RoomSource } from "@meridian-editor/roomc";
import { editor, Store } from "./store.ts";

export type CompileReply =
  | { id: number; ok: true; file: RooFile; bytes: Uint8Array; origin: { x: number; y: number }; diagnostics: Diagnostic[]; ms: number }
  | { id: number; ok: false; diagnostics: Diagnostic[]; ms: number };

export interface CompileState {
  busy: boolean;
  /** The latest successful compile (kept while a later one fails, so the views stay up). */
  result: Extract<CompileReply, { ok: true }> | null;
  /** The room and target `result` was built from. */
  room: RoomSource | null;
  target: TargetName | null;
  ok: boolean;
  diagnostics: Diagnostic[];
  ms: number;
}

export const compiled = new Store<CompileState>({ busy: false, result: null, room: null, target: null, ok: true, diagnostics: [], ms: 0 });

export function useCompiled<R>(select: (s: CompileState) => R): R {
  return useSyncExternalStore(compiled.subscribe, () => select(compiled.get()));
}

let worker: Worker | null = null;
let nextId = 1;
let latestId = 0;
const pending = new Map<number, { room: RoomSource; target: TargetName }>();

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL("./compile.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (e: MessageEvent<CompileReply>) => {
      const reply = e.data;
      const job = pending.get(reply.id);
      pending.delete(reply.id);
      if (!job || reply.id !== latestId) return;
      compiled.set((s) => ({
        busy: false,
        ok: reply.ok,
        diagnostics: reply.diagnostics,
        ms: reply.ms,
        result: reply.ok ? reply : s.result,
        room: reply.ok ? job.room : s.room,
        target: reply.ok ? job.target : s.target,
      }));
    };
  }
  return worker;
}

/** Compile now; resolves with the reply. Used by Export. */
export function compileOnce(room: RoomSource, target: TargetName): Promise<CompileReply> {
  return new Promise((resolve) => {
    const w = new Worker(new URL("./compile.worker.ts", import.meta.url), { type: "module" });
    w.onmessage = (e: MessageEvent<CompileReply>) => {
      resolve(e.data);
      w.terminate();
    };
    w.postMessage({ id: 0, room, target });
  });
}

/** Recompile the open room whenever it or the target changes. */
export function useAutoCompile(): void {
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let last: { room: RoomSource | null; target: TargetName; doc: unknown } = { room: null, target: editor.get().target, doc: null };
    const run = (): void => {
      const { room, target } = editor.get();
      if (!room) {
        compiled.set({ busy: false, result: null, room: null, target: null, ok: true, diagnostics: [], ms: 0 });
        return;
      }
      const id = nextId++;
      latestId = id;
      pending.set(id, { room, target });
      compiled.set({ busy: true });
      getWorker().postMessage({ id, room, target });
    };
    const unsubscribe = editor.subscribe(() => {
      const { room, target, doc } = editor.get();
      if (room === last.room && target === last.target) return;
      // A newly opened room or a target change compiles straight away; edits wait for a pause.
      const immediate = doc !== last.doc || target !== last.target;
      last = { room, target, doc };
      clearTimeout(timer);
      timer = setTimeout(run, immediate ? 0 : 150);
    });
    run();
    return () => {
      clearTimeout(timer);
      unsubscribe();
    };
  }, []);
}
