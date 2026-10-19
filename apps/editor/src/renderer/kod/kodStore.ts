// The Kod index the editor works from, and which class the open room is. The
// map, the Kod tab and the Kod check all read it. The room class's exits can be
// changed (kodEdit.ts): the changed file is held in the editor's state
// (store.ts kodTexts, undone with the room) and written when the room is saved.

import { useSyncExternalStore } from "react";
import { host } from "../host.ts";
import { editKod, editor, notify, Store } from "../store.ts";
import { buildLightIndex, objectLight, type KodLightIndex, type ObjectLight } from "./kodLights.ts";
import { buildKodIndex, kodCandidates, kodRoomLight, parseKodRoom, type KodIndex, type KodObject, type KodRoom } from "./kodRooms.ts";

export { kodMarks, roomBox, type KodMark } from "./kodRooms.ts";

interface KodState {
  index: KodIndex | null;
  /** The room classes' text as read, by path. */
  texts: ReadonlyMap<string, string>;
  /** Object classes that give light. */
  lights: KodLightIndex | null;
  loading: boolean;
  /** Why there's no index, if there isn't one. */
  error: string | null;
  /** Draw the placements on the map. */
  show: boolean;
  /** The class picked for a document (by name) when several use its .roo. */
  picked: Record<string, string>;
}

export const kod = new Store<KodState>({ index: null, texts: new Map(), lights: null, loading: false, error: null, show: true, picked: {} });
export const useKod = <R,>(select: (s: KodState) => R): R => useSyncExternalStore(kod.subscribe, () => select(kod.get()));

export async function reloadKod(): Promise<void> {
  kod.set({ loading: true });
  try {
    const src = await host.readKod(editor.get().prefs.kodDir);
    if (!src.files.length) {
      kod.set({ index: null, texts: new Map(), loading: false, error: src.dir ? `No room classes in ${src.dir}` : "No Kod folder: set one in Preferences (meridian-browser/server/src/kod)." });
      return;
    }
    kod.set({
      index: buildKodIndex(src.dir, src.files, src.khd),
      texts: new Map(src.files.map((f) => [f.path, f.text])),
      lights: buildLightIndex(src.objectFiles),
      loading: false,
      error: null,
    });
  } catch (e) {
    kod.set({ index: null, texts: new Map(), loading: false, error: (e as Error).message });
  }
}

/** A class's file as the editor has it: as changed, else as read. */
export function kodText(path: string): string | undefined {
  return editor.get().kodTexts[path] ?? kod.get().texts.get(path);
}

const parsed = new Map<string, { text: string; room: KodRoom }>();

/** A class as the editor has it: read again from its changed text, if it was changed. */
function edited(k: KodRoom): KodRoom {
  const text = editor.get().kodTexts[k.path];
  const index = kod.get().index;
  if (text === undefined || !index) return k;
  const hit = parsed.get(k.path);
  if (hit?.text === text) return hit.room;
  const room = parseKodRoom({ path: k.path, text }, index.rids) ?? k;
  parsed.set(k.path, { text, room });
  return room;
}

/** The open room's candidate classes, and the one in use. */
export function currentKodRoom(): { candidates: KodRoom[]; room: KodRoom | null } {
  const { index, picked } = kod.get();
  const { doc, room } = editor.get();
  if (!index || !room) return { candidates: [], room: null };
  const candidates = kodCandidates(index, doc?.name, room.roomId).map(edited);
  const name = doc ? picked[doc.name] : undefined;
  return { candidates, room: candidates.find((c) => c.className === name) ?? candidates[0] ?? null };
}

export function useKodRoom(): { candidates: KodRoom[]; room: KodRoom | null } {
  // Re-derive when either store changes; the result is cheap.
  useKod((s) => s);
  useSyncExternalStore(editor.subscribe, () => editor.get().room);
  useSyncExternalStore(editor.subscribe, () => editor.get().doc);
  useSyncExternalStore(editor.subscribe, () => editor.get().kodTexts);
  return currentKodRoom();
}

/** One undoable change to the open room's class (its .kod file's text). */
export function editRoomKod(fn: (text: string, k: KodRoom) => string): boolean {
  const k = currentKodRoom().room;
  const text = k ? kodText(k.path) : undefined;
  if (!k || text === undefined) {
    notify(kod.get().error ?? "No Kod room class uses this room's .roo file.", "error");
    return false;
  }
  return editKod(k.path, text, (t) => fn(t, k));
}

/** Write the Kod files changed since the last save, and read the Kod again; returns their paths. */
export async function saveKodChanges(): Promise<string[]> {
  const { kodTexts, kodSaved } = editor.get();
  const changed = Object.keys(kodTexts).filter((p) => kodTexts[p] !== kodSaved[p]);
  if (!changed.length) return [];
  const dir = kod.get().index?.dir ?? editor.get().prefs.kodDir;
  for (const p of changed) {
    await host.writeKod(dir, p, kodTexts[p]!, kodSaved[p]!);
    editor.set((s) => ({ kodSaved: { ...s.kodSaved, [p]: kodTexts[p]! } }));
  }
  // So the index, and so the next room opened, has the saved exits.
  await reloadKod();
  return changed;
}

/** The open room's objects that give light at a game hour, with their light. */
export function roomLights(hour: number): { object: KodObject; light: ObjectLight }[] {
  const { index, lights } = kod.get();
  const k = currentKodRoom().room;
  if (!index || !lights || !k) return [];
  const outside = kodRoomLight(index, k).outsideFactor;
  return k.objects.flatMap((object) => {
    const light = objectLight(lights, index.constants, object, hour, outside);
    return light ? [{ object, light }] : [];
  });
}
