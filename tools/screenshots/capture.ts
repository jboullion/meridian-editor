// Screenshots of the editor, taken the same way every time: the web build of the editor
// (npm run editor:web, started here if it isn't running) in a browser, opening the
// shipped rooms. Two sets:
//   website   the Meridian Shards website's pictures, 1600×900, into screenshots/
//             (Raza and its inn, as the clients' comparison shots do)
//   manual    the user manual's, 1440×900, into docs/manual/images (manual.ts)
//
//   npm run shots                      the website set
//   npm run shots:manual               the manual set
//   npm run shots -- --only raza-split some of them
//   npm run shots -- --headed          watch
//   npm run shots -- --port 5175       another port, if 5174 is taken
//
// A shot is a room, a view and what to do before the picture (shot.ts).

import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { chromium, type Page } from "@playwright/test";
import { manualShots } from "./manual.ts";
import { fit, setView, sleep, type Shot, type View } from "./shot.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");

const { values: opt } = parseArgs({
  options: {
    set: { type: "string", default: "website" },
    only: { type: "string" },
    out: { type: "string" },
    headed: { type: "boolean", default: false },
    port: { type: "string", default: "5174" },
    // The installed Edge; "chromium" for Playwright's own (npx playwright install chromium)
    channel: { type: "string", default: "msedge" },
  },
});
const URL = `http://127.0.0.1:${opt.port}/`;

const websiteShots: Shot[] = [
  { name: "raza-split", room: "src/raza", view: "split", hour: 15 },
  { name: "raza-map", room: "src/raza", view: "2d", colorBy: "floor" },
  { name: "raza-3d", room: "src/raza", view: "3d", hour: 15 },
  { name: "raza-night", room: "src/raza", view: "3d", hour: 0 },
  { name: "raza-walk", room: "src/raza", view: "3d", hour: 15, walk: 70 },
  { name: "inn-split", room: "src/razainn", view: "split", hour: 15, colorBy: "light", checks: true },
];

const SETS: Record<string, { shots: Shot[]; out: string; viewport: { width: number; height: number } }> = {
  website: { shots: websiteShots, out: join(root, "screenshots"), viewport: { width: 1600, height: 900 } },
  manual: { shots: manualShots, out: join(root, "docs", "manual", "images"), viewport: { width: 1440, height: 900 } },
};
const set = SETS[opt.set!];
if (!set) throw new Error(`no set "${opt.set}": ${Object.keys(SETS).join(" or ")}`);
const out = opt.out ?? set.out;

/** Whether the editor answers at URL; an error if something else does. */
async function up(): Promise<boolean> {
  const page = await fetch(URL).then((r) => (r.ok ? r.text() : null), () => null);
  if (page === null) return false;
  if (!page.includes("<title>Meridian Room Editor</title>")) throw new Error(`something other than the editor is running at ${URL}; try --port`);
  return true;
}

/** The editor's web build, unless it's already running. */
async function startEditor(): Promise<ChildProcess | null> {
  if (await up()) return null;
  const child = spawn("npm", ["run", "web", "-w", "@meridian-editor/app", "--", "--port", opt.port!], { cwd: root, shell: true, stdio: "ignore" });
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
  await page.locator(".room-list").waitFor();
  if (shot.room) {
    await page.getByPlaceholder(/Filter/).fill(shot.room.replace(/^\w+\//, "").replace(/\.room\.json$/, ""));
    await page.getByRole("button", { name: shot.room, exact: true }).click();
    await page.getByText(/^Opened /).waitFor({ timeout: 30_000 });
  }
  if (shot.view) {
    if (shot.room) await page.keyboard.press(viewKeys[shot.view]);
    else await setView(page, shot.view); // the shortcuts need a room
  }
  if (shot.colorBy) await page.locator("select:has(option[value='floor'])").selectOption(shot.colorBy);
  if (shot.hour !== undefined) await page.locator("select:has(option[value='flat'])").selectOption(String(shot.hour));
  if (shot.room && shot.view !== "3d") {
    await page.locator("body").click({ position: { x: 1, y: 1 } }).catch(() => {});
    await fit(page);
  }
  if (shot.prepare) await shot.prepare(page);
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
  const file = join(out, `${shot.name}.png`);
  if (shot.crop) {
    const box = await page.locator(shot.crop).first().boundingBox();
    if (!box) throw new Error(`${shot.name}: nothing matches ${shot.crop}`);
    const pad = shot.pad ?? 0;
    const view = page.viewportSize()!;
    const x = Math.max(0, box.x - pad);
    const y = Math.max(0, box.y - pad);
    const clip = { x, y, width: Math.min(view.width, box.x + box.width + pad) - x, height: Math.min(view.height, box.y + box.height + pad) - y };
    await page.screenshot({ path: file, clip });
  } else await page.screenshot({ path: file });
  console.log(`  ${shot.name} -> ${file}`);
}

const only = opt.only ? new Set(opt.only.split(",")) : null;
mkdirSync(out, { recursive: true });
const editor = await startEditor();
const browser = await chromium.launch({
  headless: !opt.headed,
  channel: opt.channel === "chromium" ? undefined : opt.channel,
  args: ["--ignore-gpu-blocklist", "--enable-gpu", "--use-angle=d3d11"],
});
try {
  for (const shot of set.shots) {
    if (only && !only.has(shot.name)) continue;
    // A page each, so no shot inherits another's preferences, dialogs or undo history.
    const context = await browser.newContext({ viewport: shot.viewport ?? set.viewport });
    try {
      await take(await context.newPage(), shot);
    } finally {
      await context.close();
    }
  }
} finally {
  await browser.close();
  editor?.kill();
}
