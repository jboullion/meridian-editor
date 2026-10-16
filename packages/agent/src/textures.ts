// The texture library from Node: which textures exist and their sizes, read
// the way the editor's library.ts does (grdNNNNN.bgf, stored transposed).

import { gridTextureName, parseBgf, type Bgf } from "../../../apps/editor/src/renderer/textures/bgf.ts";
import { listTextures, readTexture } from "../../../apps/editor/src/main/textures.ts";
import type { Session } from "./session.ts";

const cache = new Map<string, Promise<Bgf | null>>();

export async function loadGridTexture(session: Session, number: number): Promise<Bgf | null> {
  const dir = session.prefs().texturesDir;
  const key = `${dir}|${number}`;
  let p = cache.get(key);
  if (!p) {
    p = (async () => {
      const known = await session.knownTextures();
      if (!known?.has(number)) return null;
      return parseBgf(await readTexture(dir, gridTextureName(number), session.repoRoot));
    })().catch(() => null);
    cache.set(key, p);
  }
  return p;
}

/** Upright size in texels, the shrink factor, and the width in editor units (roomedit GetWallTextureSize). */
export async function textureSize(session: Session, number: number): Promise<{ width: number; height: number; shrink: number; frames: number; editorWidth: number; editorHeight: number } | null> {
  const bgf = await loadGridTexture(session, number);
  const bmp = bgf?.bitmaps[0];
  if (!bgf || !bmp) return null;
  const width = bmp.height;
  const height = bmp.width;
  return { width, height, shrink: bgf.shrink, frames: bgf.bitmaps.length, editorWidth: Math.max(1, Math.trunc(width / bgf.shrink)), editorHeight: Math.max(1, Math.trunc(height / bgf.shrink)) };
}

export async function texturesFolder(session: Session): Promise<string> {
  return (await listTextures(session.prefs().texturesDir, session.repoRoot)).dir;
}
