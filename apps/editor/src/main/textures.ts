// The texture library: grdNNNNN.bgf files in a folder (roomedit's BitmapDir).
// By default the installed Meridian 104 client's resource folder.

import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const TEXTURE_FILE = /^grd(\d{5})\.bgf$/i;

export function defaultTexturesDir(): string {
  const local = process.env.LOCALAPPDATA;
  const candidates = [process.env.EDITOR_TEXTURES_DIR, local && join(local, "Meridian-104", "resource")].filter((d): d is string => !!d);
  return candidates.find((d) => existsSync(d)) ?? "";
}

export async function listTextures(dir: string): Promise<{ dir: string; textures: { number: number; name: string }[] }> {
  const folder = dir || defaultTexturesDir();
  if (!folder) return { dir: "", textures: [] };
  let names: string[];
  try {
    names = await readdir(folder);
  } catch {
    return { dir: folder, textures: [] };
  }
  const textures = names
    .map((name) => ({ name, m: TEXTURE_FILE.exec(name) }))
    .filter((t) => t.m)
    .map((t) => ({ number: Number(t.m![1]), name: t.name }))
    .sort((a, b) => a.number - b.number);
  return { dir: folder, textures };
}

const RESOURCE_FILE = /^[\w-]+\.bgf$/i;

/** Any .bgf in the folder (object sprites, for where their lights sit). */
export async function readResource(dir: string, name: string): Promise<Uint8Array> {
  if (!RESOURCE_FILE.test(name)) throw new Error(`not a .bgf file name: ${name}`);
  return new Uint8Array(await readFile(join(dir || defaultTexturesDir(), name)));
}

export async function readTexture(dir: string, name: string): Promise<Uint8Array> {
  if (!TEXTURE_FILE.test(name)) throw new Error(`not a texture file name: ${name}`);
  return new Uint8Array(await readFile(join(dir || defaultTexturesDir(), name)));
}
