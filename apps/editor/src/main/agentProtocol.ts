// The link between an agent (packages/agent's MCP server) and a running
// editor. The agent POSTs one call at a time to the editor's endpoint (the
// Electron main process, or the Vite dev server for the web build), which hands
// it to the page and returns the page's answer. Types only, so the main
// process, the preload, the page and the agent can all import it.
//
// The agent keeps the room logic: it reads the state, works on the room with
// the same ops, and sends the result back as one labelled undo step.

import type { TargetName } from "@meridian-editor/roo";
import type { RoomSource } from "@meridian-editor/roomc";

export type AgentKind = "vertex" | "linedef" | "sector" | "thing";

export interface AgentPrefs {
  defaults: {
    floorHeight: number;
    ceilingHeight: number;
    floorTexture: number;
    ceilingTexture: number;
    light: number;
    wallTexture: number;
    upperTexture: number;
    lowerTexture: number;
    passable: boolean;
  };
  polygonSides: number;
  pillar: boolean;
  torchAngle: number;
  texturesDir: string;
  kodDir: string;
}

export interface AgentLight {
  mode: "game" | "flat";
  hour: number;
  playerLight: number;
  fog: boolean;
  sources: boolean;
}

export interface AgentState {
  /** The rooms folder (absolute). Filled in by the endpoint. */
  roomsDir: string;
  /** The open room's file, absolute (null until saved). Filled in by the endpoint from the page's doc id. */
  path: string | null;
  name: string | null;
  room: RoomSource | null;
  dirty: boolean;
  /** Bumped by every change to the room in the page. */
  revision: number;
  undoDepth: number;
  redoDepth: number;
  target: TargetName;
  prefs: AgentPrefs;
  selection: { kind: AgentKind; indices: number[] } | null;
  view: "2d" | "3d" | "split";
  mode: AgentKind;
  light: AgentLight;
  display: { grid: number; snap: boolean; showGrid: boolean; colorBy: "floor" | "light" | "ceiling"; ceilings: boolean; kod: boolean };
  walk: { active: boolean; at: [number, number] | null; floor: number; angle: number };
  /** The Kod class picked for this room when several share its .roo. */
  kodClass: string | null;
  /** The page's own doc id; the endpoint turns it into `path`. */
  docId?: string | null;
}

/** A camera for render3d: editor units; angle in degrees, 0 north, 90 east; pitch in degrees, up positive. */
export interface AgentCamera {
  x: number;
  y: number;
  /** Eye height above the floor there; default the player's eye (48). */
  height?: number;
  angle: number;
  pitch?: number;
}

export type AgentCall =
  | { op: "state" }
  | { op: "replace"; label: string; room: RoomSource; ifRevision: number }
  /** `path` is absolute; the endpoint adds the page's `id` for it. */
  | { op: "load"; path: string | null; id?: string | null; name: string; room: RoomSource; saved: boolean }
  | { op: "save"; path?: string; id?: string; name?: string }
  | { op: "undo" }
  | { op: "redo" }
  | { op: "target"; target: TargetName }
  | { op: "prefs"; prefs: AgentPrefs }
  | { op: "select"; selection: { kind: AgentKind; indices: number[] } | null; center?: boolean }
  | { op: "view"; view?: "2d" | "3d" | "split"; fit?: boolean; center?: [number, number]; zoom?: number; mode?: AgentKind }
  | { op: "light"; light: Partial<AgentLight> }
  | { op: "display"; display: Partial<AgentState["display"]> }
  | { op: "notify"; text: string; kind?: "info" | "error" }
  | { op: "walk"; action: "start" | "stop"; at?: [number, number] }
  | { op: "kodClass"; className: string }
  | { op: "render3d"; camera?: AgentCamera | "current" | "overview"; light?: Partial<AgentLight>; width?: number; height?: number }
  /** Handled by the Electron main process itself. */
  | { op: "screenshot" };

export type AgentReply = { ok: true; value: unknown } | { ok: false; error: string };

/** What an endpoint writes so agents can find it (see agentFiles.ts). */
export interface AgentEndpoint {
  url: string;
  token: string;
  pid: number;
  kind: "electron" | "web";
}
