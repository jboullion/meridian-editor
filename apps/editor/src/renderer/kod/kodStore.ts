// The Kod index the editor works from, and which class the open room is. The
// map, the Kod tab and the Kod check all read it; nothing here writes Kod.

import { useSyncExternalStore } from "react";
import { host } from "../host.ts";
import { editor, Store } from "../store.ts";
import { buildLightIndex, objectLight, type KodLightIndex, type ObjectLight } from "./kodLights.ts";
import { buildKodIndex, kodCandidates, kodRoomLight, type KodIndex, type KodObject, type KodRoom } from "./kodRooms.ts";

export { kodMarks, roomBox, type KodMark } from "./kodRooms.ts";

interface KodState {
  index: KodIndex | null;
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

export const kod = new Store<KodState>({ index: null, lights: null, loading: false, error: null, show: true, picked: {} });
export const useKod = <R,>(select: (s: KodState) => R): R => useSyncExternalStore(kod.subscribe, () => select(kod.get()));

export async function reloadKod(): Promise<void> {
  kod.set({ loading: true });
  try {
    const src = await host.readKod(editor.get().prefs.kodDir);
    if (!src.files.length) {
      kod.set({ index: null, loading: false, error: src.dir ? `No room classes in ${src.dir}` : "No Kod folder: set one in Preferences (meridian-browser/server/src/kod)." });
      return;
    }
    kod.set({ index: buildKodIndex(src.dir, src.files, src.khd), lights: buildLightIndex(src.objectFiles), loading: false, error: null });
  } catch (e) {
    kod.set({ index: null, loading: false, error: (e as Error).message });
  }
}

/** The open room's candidate classes, and the one in use. */
export function currentKodRoom(): { candidates: KodRoom[]; room: KodRoom | null } {
  const { index, picked } = kod.get();
  const { doc, room } = editor.get();
  if (!index || !room) return { candidates: [], room: null };
  const candidates = kodCandidates(index, doc?.name, room.roomId);
  const name = doc ? picked[doc.name] : undefined;
  return { candidates, room: candidates.find((c) => c.className === name) ?? candidates[0] ?? null };
}

export function useKodRoom(): { candidates: KodRoom[]; room: KodRoom | null } {
  // Re-derive when either store changes; the result is cheap.
  useKod((s) => s);
  useSyncExternalStore(editor.subscribe, () => editor.get().room);
  useSyncExternalStore(editor.subscribe, () => editor.get().doc);
  return currentKodRoom();
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
