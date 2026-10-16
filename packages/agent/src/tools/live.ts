// Tools that need the running editor: showing the user things, the 3D view,
// walking where they can watch, and screenshots.

import { z } from "zod";
import type { AgentCamera, AgentLight } from "../../../../apps/editor/src/main/agentProtocol.ts";
import { OpError, type EditorLink, type Session } from "../session.ts";
import { ImageOutput, index, kind, point, tool } from "../tool.ts";
import { status } from "./document.ts";

export function needEditor(s: Session): EditorLink {
  const link = s.editor();
  if (!link) throw new OpError("This needs the running editor: start it (npm run editor, or npm run editor:web with the page open), then call connect_editor.");
  return link;
}

const light = {
  hour: z.number().int().min(0).max(23).optional().describe("Game hour: sets the ambient light, the sun's direction and its shading from the room's Kod"),
  lighting: z.enum(["game", "flat"]).optional().describe("game: the client's lighting; flat: each sector's light level"),
  playerLight: z.number().int().min(0).max(255).optional(),
  fog: z.boolean().optional(),
  sources: z.boolean().optional().describe("Light from the room's Kod objects (fires, lamps, candles, signs)"),
};

function lightPatch(a: { hour?: number; lighting?: "game" | "flat"; playerLight?: number; fog?: boolean; sources?: boolean }): Partial<AgentLight> {
  return {
    ...(a.hour !== undefined ? { hour: a.hour } : {}),
    ...(a.lighting ? { mode: a.lighting } : {}),
    ...(a.playerLight !== undefined ? { playerLight: a.playerLight } : {}),
    ...(a.fog !== undefined ? { fog: a.fog } : {}),
    ...(a.sources !== undefined ? { sources: a.sources } : {}),
  };
}

export const liveTools = [
  tool({
    name: "select",
    title: "Select in the editor",
    description: "Select items in the editor, so the user sees them highlighted (and in the inspector); center scrolls the map to them. null indices clears the selection. Needs the editor.",
    input: { kind, indices: z.array(index).nullable(), center: z.boolean().optional() },
    run: async (s, { kind: k, indices, center }) => needEditor(s).call({ op: "select", selection: indices?.length ? { kind: k, indices } : null, center }),
  }),

  tool({
    name: "set_view",
    title: "Change the editor's view",
    description: "Show the map, the 3D preview or both; fit the room; center the map on a point; zoom (factor > 1 zooms in); switch the editing mode. Needs the editor.",
    input: {
      view: z.enum(["2d", "3d", "split"]).optional(),
      fit: z.boolean().optional(),
      center: point.optional(),
      zoom: z.number().positive().optional(),
      mode: kind.optional(),
    },
    run: async (s, a) => {
      await needEditor(s).call({ op: "view", ...a });
      return { done: true };
    },
  }),

  tool({
    name: "set_lighting",
    title: "Set the 3D preview's lighting",
    description: "The preview's lighting, as the toolbar and View → Lighting set it. Needs the editor.",
    input: light,
    run: async (s, a) => needEditor(s).call({ op: "light", light: lightPatch(a) }),
  }),

  tool({
    name: "set_display",
    title: "Set map display options",
    description: "The map's grid size (and whether it shows), snapping, shading (floor, ceiling or light), ceilings in the 3D view, and the Kod overlay. Needs the editor.",
    input: {
      grid: z.number().int().min(1).max(256).optional(),
      showGrid: z.boolean().optional(),
      snap: z.boolean().optional(),
      colorBy: z.enum(["floor", "ceiling", "light"]).optional(),
      ceilings: z.boolean().optional(),
      kod: z.boolean().optional(),
    },
    run: async (s, a) => needEditor(s).call({ op: "display", display: a }),
  }),

  tool({
    name: "notify",
    title: "Message the user",
    description: "Show a short message in the editor's status bar. Needs the editor.",
    input: { text: z.string().max(300), error: z.boolean().optional() },
    run: async (s, { text, error }) => {
      await needEditor(s).call({ op: "notify", text, kind: error ? "error" : "info" });
      return { done: true };
    },
  }),

  tool({
    name: "walk_live",
    title: "Walk mode in the editor",
    description: "Start walk mode in the editor's 3D view (at a point, or the Kod arrival square), so the user can walk from there, or stop it. For an automatic walk test use walk. Needs the editor.",
    input: { action: z.enum(["start", "stop"]), at: point.optional() },
    run: async (s, { action, at }) => {
      await needEditor(s).call({ op: "walk", action, at });
      return { done: true };
    },
  }),

  tool({
    name: "render_3d",
    title: "Picture of the 3D view",
    description:
      'A picture from the editor\'s 3D preview, lit the way the game client lights rooms. camera: "current" (what the user sees, or the walker\'s eyes while walking), "overview" (the whole room from above), or a spot at eye level: {x, y, angle, pitch?, height?} in editor units, angle in degrees with 0 north and 90 east, height above the floor (default 48, the player\'s eye). Needs the editor.',
    input: {
      camera: z
        .union([
          z.enum(["current", "overview"]),
          z.object({ x: z.number(), y: z.number(), angle: z.number(), pitch: z.number().min(-70).max(70).optional(), height: z.number().optional() }),
        ])
        .optional(),
      ...light,
      width: z.number().int().min(64).max(2048).optional(),
      height: z.number().int().min(64).max(2048).optional(),
    },
    annotations: { readOnlyHint: true },
    run: async (s, a) => {
      const out = await needEditor(s).call<{ png: string; width: number; height: number; notes: string[] }>({
        op: "render3d",
        camera: a.camera as AgentCamera | "current" | "overview" | undefined,
        light: lightPatch(a),
        width: a.width,
        height: a.height,
      });
      return new ImageOutput(new Uint8Array(Buffer.from(out.png, "base64")), { size: [out.width, out.height], camera: a.camera ?? "current", ...(out.notes.length ? { notes: out.notes } : {}) });
    },
  }),

  tool({
    name: "screenshot_window",
    title: "Screenshot of the editor",
    description: "A screenshot of the editor's whole window, as the user sees it. Desktop app only. Needs the editor.",
    input: {},
    annotations: { readOnlyHint: true },
    run: async (s) => {
      const out = await needEditor(s).call<{ png: string; size: { width: number; height: number } }>({ op: "screenshot" });
      return new ImageOutput(new Uint8Array(Buffer.from(out.png, "base64")), { size: [out.size.width, out.size.height], ...status(s) });
    },
  }),
];
