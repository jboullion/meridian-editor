// What a screenshot is, and helpers for setting one up in the editor's web build.
// The helpers drive the development hooks the renderer installs (main.tsx's
// __editor, MapView's __map), so shots can click at room coordinates.

import type { Page } from "@playwright/test";

export type View = "2d" | "3d" | "split";
export type Kind = "thing" | "vertex" | "linedef" | "sector";

export interface Shot {
  name: string;
  /** A room in the room list ("src/raza"); none for the welcome screen. */
  room?: string;
  view?: View;
  /** Game hour for the lighting (the toolbar's hour menu) */
  hour?: number;
  /** Walk mode from the Kod arrival square, turned this many degrees to the right */
  walk?: number;
  /** Shade the map by floor, ceiling or light */
  colorBy?: "floor" | "ceiling" | "light";
  /** Run the checks (F9) for the bottom panel */
  checks?: boolean;
  /** Anything else to do before the picture: open a dialog, select something, draw. */
  prepare?: (page: Page) => Promise<void>;
  /** Picture just this element (a CSS selector) instead of the window. */
  crop?: string;
  /** Pixels of the window to keep around the cropped element. */
  pad?: number;
  /** The window size, if not the set's. */
  viewport?: { width: number; height: number };
}

/** The renderer's development hooks. page.evaluate callbacks run in the page, so each reaches them through globalThis itself. */
interface Hooks {
  __editor: {
    editor: { get(): EditorState; set(patch: Partial<EditorState>): void };
    runCommand(id: string): void;
  };
  __map: { toClient(x: number, y: number): [number, number] };
}

interface Side {
  sector: number;
}
interface EditorState {
  room: {
    vertices: [number, number][];
    linedefs: { start: number; end: number; front: Side | null; back: Side | null }[];
    sectors: unknown[];
    things: { x: number; y: number }[];
  } | null;
  mode: Kind;
  view: View;
  selection: { kind: Kind; indices: number[] } | null;
}


export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Run an editor command by id (commands.tsx). */
export async function cmd(page: Page, id: string): Promise<void> {
  await page.evaluate((id) => (globalThis as unknown as Hooks).__editor.runCommand(id), id);
  await sleep(150);
}

/** Select items as if clicked, in their mode. */
export async function select(page: Page, kind: Kind, indices: number[]): Promise<void> {
  await page.evaluate(([kind, indices]) => (globalThis as unknown as Hooks).__editor.editor.set({ mode: kind, selection: { kind, indices } }), [kind, indices] as const);
  await sleep(100);
}

export async function setView(page: Page, view: View): Promise<void> {
  await page.evaluate((view) => (globalThis as unknown as Hooks).__editor.editor.set({ view }), view);
  await sleep(300);
}

/** Linedefs with a side in a sector. */
export function sectorLinedefs(page: Page, sector: number): Promise<number[]> {
  return page.evaluate((sector) => {
    const room = (globalThis as unknown as Hooks).__editor.editor.get().room!;
    return room.linedefs.flatMap((l, i) => (l.front?.sector === sector || l.back?.sector === sector ? [i] : []));
  }, sector);
}

/** Where a room point is in the window. */
export function at(page: Page, x: number, y: number): Promise<[number, number]> {
  return page.evaluate(([x, y]) => (globalThis as unknown as Hooks).__map.toClient(x, y), [x, y] as const);
}

export async function fit(page: Page): Promise<void> {
  await cmd(page, "view.fit");
  await sleep(300);
}

/** Centre the map on the selection and zoom in a few steps. */
export async function focus(page: Page, zoom = 2): Promise<void> {
  await cmd(page, "view.center");
  for (let i = 0; i < zoom; i++) await cmd(page, "view.zoomIn");
  await sleep(200);
}

export async function clickAt(page: Page, x: number, y: number, options: { button?: "left" | "right"; modifiers?: ("Shift" | "Control")[] } = {}): Promise<void> {
  const [cx, cy] = await at(page, x, y);
  for (const m of options.modifiers ?? []) await page.keyboard.down(m);
  await page.mouse.click(cx, cy, { button: options.button ?? "left" });
  for (const m of options.modifiers ?? []) await page.keyboard.up(m);
  await sleep(150);
}

export async function hover(page: Page, x: number, y: number): Promise<void> {
  const [cx, cy] = await at(page, x, y);
  await page.mouse.move(cx, cy, { steps: 4 });
  await sleep(150);
}

/** Drag on the map between room points; `hold` leaves the button down (a picture mid-drag). */
export async function drag(page: Page, from: [number, number], to: [number, number], hold = false): Promise<void> {
  const [x0, y0] = await at(page, ...from);
  const [x1, y1] = await at(page, ...to);
  await page.mouse.move(x0, y0);
  await page.mouse.down();
  await page.mouse.move(x1, y1, { steps: 12 });
  if (!hold) await page.mouse.up();
  await sleep(200);
}

/** Type into an inspector field by its label, in the section whose title starts with `section`, and commit it with Enter. */
export async function setField(page: Page, label: string, value: string | number, section?: string): Promise<void> {
  let scope = page.locator(".inspector .panel-section");
  if (section) scope = scope.filter({ has: page.locator("header h3", { hasText: section }) });
  const field = scope.locator("label.field", { has: page.getByText(label, { exact: true }) }).first().locator("input").last();
  await field.fill(String(value));
  await field.press("Enter");
  await sleep(150);
}

/** File → New room with the dialog's defaults (16 × 16 squares, one floor sector), shown on the map and fitted. */
export async function newRoom(page: Page, name = "tutorial"): Promise<void> {
  await cmd(page, "file.new");
  await page.locator(".dialog label.field", { hasText: "Name" }).locator("input").fill(name);
  await page.locator(".dialog button[type=submit]").click();
  await sleep(300);
  await fit(page);
}
