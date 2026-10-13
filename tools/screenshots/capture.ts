// Screenshots of the editor for the Meridian Shards website, taken the same way every time: the
// web build of the editor (npm run editor:web, started here if it isn't running) in a 1600×900
// browser, opening Raza and its inn as the clients' comparison shots do.
//
//   npm run shots                      every shot, into screenshots/<name>.png
//   npm run shots -- --only raza-split some
//   npm run shots -- --headed          watch
//
// The shots are the list below: a room, a view and what to do before the picture.

import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { chromium, type Page } from "@playwright/test";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const URL = "http://127.0.0.1:5174/";

const { values: opt } = parseArgs({
  options: {
    only: { type: "string" },
    out: { type: "string", default: join(root, "screenshots") },
    headed: { type: "boolean", default: false },
    // The installed Edge; "chromium" for Playwright's own (npx playwright install chromium)
    channel: { type: "string", default: "msedge" },
  },
});

type View = "2d" | "3d" | "split";
interface Shot {
  name: string;
  room: string;
  view: View;
  /** Game hour for the lighting (the toolbar's hour menu) */
  hour?: number;
  /** Walk mode from the Kod arrival square, turned this many degrees to the right */
  walk?: number;
  /** Shade the map by floor, ceiling or light */
  colorBy?: "floor" | "ceiling" | "light";
  /** Run the checks (F9) for the bottom panel */
  checks?: boolean;
}

const shots: Shot[] = [
  { name: "raza-split", room: "src/raza", view: "split", hour: 15 },
  { name: "raza-map", room: "src/raza", view: "2d", colorBy: "floor" },
  { name: "raza-3d", room: "src/raza", view: "3d", hour: 15 },
  { name: "raza-night", room: "src/raza", view: "3d", hour: 0 },
  { name: "raza-walk", room: "src/raza", view: "3d", hour: 15, walk: 70 },
  { name: "inn-split", room: "src/razainn", view: "split", hour: 15, colorBy: "light", checks: true },
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const up = () => fetch(URL).then((r) => r.ok, () => false);

/** The editor's web build, unless it's already running. */
async function startEditor(): Promise<ChildProcess | null> {
  if (await up()) return null;
  const child = spawn("npm", ["run", "editor:web"], { cwd: root, shell: true, stdio: "ignore" });
  for (let i = 0; i < 120; i++) {
    if (await up()) return child;
    await sleep(500);
  }
  child.kill();
  throw new Error(`the editor didn't start at ${URL}`);
}

const viewKeys: Record<View, string> = { "2d": "Control+1", "3d": "Control+2", split: "Control+3" };

async function take(page: Page, shot: Shot): Promise<void> {
  await page.goto(URL);
  await page.getByPlaceholder(/Filter/).fill(shot.room.replace(/^src\//, "").replace(/\.room\.json$/, ""));
  await page.getByRole("button", { name: shot.room, exact: true }).click();
  await page.getByText(/^Opened /).waitFor({ timeout: 30_000 });
  await page.keyboard.press(viewKeys[shot.view]);
  if (shot.colorBy) await page.locator("select:has(option[value='floor'])").selectOption(shot.colorBy);
  if (shot.hour !== undefined) await page.locator("select:has(option[value='flat'])").selectOption(String(shot.hour));
  if (shot.view !== "3d") {
    await page.locator("body").click({ position: { x: 1, y: 1 } }).catch(() => {});
    await page.keyboard.press("f"); // fit the room
  }
  if (shot.checks) await page.keyboard.press("F9");
  if (shot.walk !== undefined) {
    await page.getByRole("button", { name: "Walk", exact: true }).click();
    // drag to look round, as a player would
    const view = page.locator("canvas").last();
    const box = (await view.boundingBox())!;
    const cx = box.x + box.width / 2,
      cy = box.y + box.height / 2;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + shot.walk * 4, cy, { steps: 10 });
    await page.mouse.up();
  }
  // textures, the BSP compile and the lighting settle
  await page.waitForLoadState("networkidle").catch(() => {});
  await sleep(3000);
  const file = join(opt.out!, `${shot.name}.png`);
  await page.screenshot({ path: file });
  console.log(`  ${shot.name} -> ${file}`);
}

const only = opt.only ? new Set(opt.only.split(",")) : null;
mkdirSync(opt.out!, { recursive: true });
const editor = await startEditor();
const browser = await chromium.launch({
  headless: !opt.headed,
  channel: opt.channel === "chromium" ? undefined : opt.channel,
  args: ["--ignore-gpu-blocklist", "--enable-gpu", "--use-angle=d3d11"],
});
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  for (const shot of shots) if (!only || only.has(shot.name)) await take(page, shot);
} finally {
  await browser.close();
  editor?.kill();
}
