// The user manual's pictures (docs/manual/images): npm run shots:manual.
// Most use the shipped rooms Raza (src/raza) and its inn (src/razainn); the
// tutorial's are of a room built here, step by step, as the tutorial chapter does.

import type { Page } from "@playwright/test";
import { clickAt, cmd, drag, focus, hover, newRoom, sectorLinedefs, select, setField, sleep, type Shot } from "./shot.ts";

/** A building in Raza with a raised floor, used for the selection pictures. */
const RAZA_SECTOR = 52;
const RAZA_SECTOR_AT: [number, number] = [1228, 1464];

// The tutorial's textures: Raza's paving, the inn's walls and its ceiling.
export const TUTORIAL = { floor: 9603, wall: 9628, ceiling: 9652, ceilingHeight: 160, platform: 48, step: 24 };
const PLATFORM: [[number, number], [number, number]] = [
  [576, 320],
  [896, 704],
];
const STEP: [[number, number], [number, number]] = [
  [448, 384],
  [576, 640],
];

/**
 * The tutorial room, up to a step:
 * 1 new room · 2 floor, ceiling and wall textures · 3 the platform · 4 the step · 5 textures on the lips
 */
async function tutorial(page: Page, upTo: number): Promise<void> {
  await newRoom(page);
  if (upTo < 2) return;
  await select(page, "sector", [0]);
  await setField(page, "Floor texture", TUTORIAL.floor);
  await setField(page, "Ceiling texture", TUTORIAL.ceiling);
  await setField(page, "Ceiling height", TUTORIAL.ceilingHeight);
  await cmd(page, "mode.linedef");
  await cmd(page, "edit.selectAll");
  await setField(page, "Normal", TUTORIAL.wall, "Front side");
  await cmd(page, "edit.deselect");
  if (upTo < 3) return;
  await raise(page, PLATFORM, TUTORIAL.platform);
  if (upTo < 4) return;
  await raise(page, STEP, TUTORIAL.step);
  if (upTo < 5) return;
  // Box-select the platform's and the step's walls, and give their lower parts a texture.
  await cmd(page, "mode.linedef");
  await drag(page, [432, 304], [912, 720]);
  await setField(page, "Below", TUTORIAL.wall, "Front side");
  await setField(page, "Below", TUTORIAL.wall, "Back side");
  await cmd(page, "edit.deselect");
}

/** Drag out a rectangle, then select the sector it made and set its floor. */
async function raise(page: Page, [from, to]: [[number, number], [number, number]], floor: number): Promise<void> {
  await cmd(page, "tool.rectangle");
  await drag(page, from, to);
  await cmd(page, "edit.deselect"); // back to Select
  await cmd(page, "mode.sector");
  await clickAt(page, (from[0] + to[0]) / 2, (from[1] + to[1]) / 2);
  await setField(page, "Floor height", floor);
}

async function selectRazaSector(page: Page): Promise<void> {
  await select(page, "sector", [RAZA_SECTOR]);
  await focus(page, 1);
}

async function selectRazaLinedef(page: Page): Promise<void> {
  const lines = await sectorLinedefs(page, RAZA_SECTOR);
  await select(page, "linedef", [lines[0]!]);
  await focus(page, 1);
}

/** Right-click the map at a room point, for the context menu. */
async function rightClick(page: Page, x: number, y: number): Promise<void> {
  await clickAt(page, x, y, { button: "right" });
  await sleep(200);
}

export const manualShots: Shot[] = [
  // The window
  { name: "welcome" },
  { name: "window", room: "src/raza", view: "split", hour: 13 },
  { name: "toolbar", room: "src/raza", view: "split", hour: 13, crop: ".toolbar" },
  { name: "room-list", room: "src/raza", view: "2d", crop: ".sidebar.left" },
  {
    name: "palette",
    room: "src/raza",
    view: "2d",
    crop: ".palette",
    prepare: async (page) => {
      await cmd(page, "view.palette");
      await page.keyboard.type("sector");
      await sleep(200);
    },
  },

  // Selecting and the inspector
  { name: "inspector-room", room: "src/raza", view: "2d", crop: ".sidebar.right" },
  { name: "select-sector", room: "src/raza", view: "2d", prepare: selectRazaSector },
  { name: "inspector-sector", room: "src/raza", view: "2d", crop: ".sidebar.right", prepare: selectRazaSector },
  { name: "select-linedef", room: "src/raza", view: "2d", prepare: selectRazaLinedef },
  { name: "inspector-linedef", room: "src/raza", view: "2d", crop: ".sidebar.right", prepare: selectRazaLinedef },
  {
    name: "inspector-thing",
    room: "src/raza",
    view: "2d",
    crop: ".inspector .panel-section",
    prepare: (page) => select(page, "thing", [0]),
  },
  {
    name: "context-menu-sector",
    room: "src/raza",
    view: "2d",
    crop: ".context-menu",
    pad: 160,
    prepare: async (page) => {
      await selectRazaSector(page);
      await rightClick(page, ...RAZA_SECTOR_AT);
    },
  },
  {
    name: "context-menu-linedef",
    room: "src/raza",
    view: "2d",
    crop: ".context-menu",
    pad: 160,
    prepare: async (page) => {
      await selectRazaLinedef(page);
      const [a, b] = await page.evaluate(() => {
        const e = (globalThis as unknown as { __editor: { editor: { get(): { room: { vertices: [number, number][]; linedefs: { start: number; end: number }[] }; selection: { indices: number[] } } } } }).__editor.editor.get();
        const l = e.room.linedefs[e.selection.indices[0]!]!;
        return [e.room.vertices[l.start]!, e.room.vertices[l.end]!];
      });
      await rightClick(page, (a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
    },
  },

  // Drawing
  {
    name: "draw-lines",
    view: "2d",
    prepare: async (page) => {
      await tutorial(page, 2);
      await cmd(page, "tool.draw");
      for (const [x, y] of [
        [128, 896],
        [384, 896],
        [384, 640],
      ] as const)
        await clickAt(page, x, y);
      await hover(page, 128, 640);
    },
  },

  // Map shading
  { name: "map-floor", room: "src/raza", view: "2d", colorBy: "floor" },
  { name: "map-light", room: "src/razainn", view: "2d", colorBy: "light" },

  // Dialogs
  {
    name: "dialog-preferences",
    crop: ".dialog",
    viewport: { width: 1440, height: 1000 }, // tall enough for the whole form
    prepare: (page) => cmd(page, "edit.preferences"),
  },
  {
    name: "dialog-lighting",
    room: "src/raza",
    view: "3d",
    crop: ".dialog",
    prepare: (page) => cmd(page, "view.lighting"),
  },
  {
    name: "dialog-find",
    room: "src/raza",
    view: "2d",
    crop: ".dialog",
    prepare: (page) => cmd(page, "search.find"),
  },
  {
    name: "dialog-rotate",
    room: "src/raza",
    view: "2d",
    crop: ".dialog",
    prepare: async (page) => {
      await selectRazaSector(page);
      await cmd(page, "edit.rotateScale");
    },
  },
  {
    name: "dialog-statistics",
    room: "src/raza",
    view: "2d",
    crop: ".dialog",
    prepare: (page) => cmd(page, "check.stats"),
  },
  {
    name: "textures",
    room: "src/razainn",
    view: "2d",
    crop: ".dialog",
    prepare: async (page) => {
      await cmd(page, "textures.browse");
      await sleep(1500);
    },
  },

  // 3D preview and walking
  { name: "preview-day", room: "src/raza", view: "3d", hour: 13 },
  { name: "preview-night", room: "src/raza", view: "3d", hour: 0 },
  {
    name: "preview-flat",
    room: "src/raza",
    view: "3d",
    prepare: async (page) => {
      await page.locator("select:has(option[value='flat'])").selectOption("flat");
      await sleep(300);
    },
  },
  { name: "walk", room: "src/raza", view: "3d", hour: 13, walk: 70 },

  // Kod placements
  { name: "kod-map", room: "src/razainn", view: "2d" },
  {
    name: "kod-panel",
    room: "src/raza",
    view: "2d",
    crop: ".bottom-panel",
    prepare: async (page) => {
      await page.locator(".bottom-panel .tabs button", { hasText: /^Kod/ }).click();
      await sleep(200);
    },
  },

  // Checks and compiling
  {
    // The tutorial room before its lips have textures, and a stray vertex: warnings, and an error with a Fix.
    name: "checks",
    view: "2d",
    checks: true,
    crop: ".bottom-panel",
    prepare: async (page) => {
      await tutorial(page, 4);
      await cmd(page, "mode.vertex");
      await hover(page, 192, 192);
      await cmd(page, "vertex.add");
      await cmd(page, "edit.deselect");
    },
  },
  {
    name: "compile-error",
    view: "split",
    hour: 13,
    prepare: async (page) => {
      await tutorial(page, 2);
      await cmd(page, "tool.thing");
      await clickAt(page, 256, 256);
      await cmd(page, "edit.deselect");
      await page.locator(".bottom-panel .tabs button", { hasText: /^Compile/ }).click();
    },
  },

  // The tutorial
  {
    name: "tutorial-new-room",
    crop: ".dialog",
    prepare: async (page) => {
      await cmd(page, "file.new");
      await page.locator(".dialog label.field", { hasText: "Name" }).locator("input").fill("tutorial");
    },
  },
  { name: "tutorial-empty", view: "split", hour: 13, prepare: (page) => tutorial(page, 1) },
  {
    name: "tutorial-texture-picker",
    view: "split",
    crop: ".dialog",
    prepare: async (page) => {
      await tutorial(page, 1);
      await select(page, "sector", [0]);
      await page.locator(".inspector label.field", { has: page.getByText("Floor texture", { exact: true }) }).locator(".swatch-button").click();
      await page.locator(".texture-browser-head input").fill("96"); // Raza's and the inn's textures
      await sleep(1500);
    },
  },
  { name: "tutorial-textured", view: "split", hour: 13, prepare: (page) => tutorial(page, 2) },
  {
    name: "tutorial-rectangle",
    view: "split",
    hour: 13,
    prepare: async (page) => {
      await tutorial(page, 2);
      await cmd(page, "tool.rectangle");
      await drag(page, ...PLATFORM, true); // the picture is taken mid-drag
    },
  },
  {
    name: "tutorial-platform",
    view: "split",
    hour: 13,
    prepare: (page) => tutorial(page, 3), // the platform stays selected, with its floor height in the inspector
  },
  {
    name: "tutorial-step",
    view: "split",
    hour: 13,
    prepare: async (page) => {
      await tutorial(page, 4);
      await cmd(page, "edit.deselect");
    },
  },
  {
    name: "tutorial-lips",
    view: "split",
    hour: 13,
    prepare: async (page) => {
      await tutorial(page, 4);
      await cmd(page, "mode.linedef");
      await drag(page, [432, 304], [912, 720]);
    },
  },
  {
    name: "tutorial-walk",
    view: "split",
    hour: 13,
    prepare: async (page) => {
      await tutorial(page, 5);
      await hover(page, 160, 512);
      await cmd(page, "view.walkHere");
      await sleep(500);
    },
  },
  { name: "tutorial-checks", view: "2d", checks: true, crop: ".bottom-panel", prepare: (page) => tutorial(page, 5) },
];
