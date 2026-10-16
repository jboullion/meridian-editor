// A way for agents to get a picture of the 3D preview: PreviewView registers
// `capture` while it's mounted.

import type { AgentCamera } from "../../main/agentProtocol.ts";
import type { PreviewLight } from "../store.ts";

export interface CaptureOptions {
  /** "current": the view as it is; "overview": the whole room from above, as Fit frames it. */
  camera?: AgentCamera | "current" | "overview";
  light?: Partial<PreviewLight>;
  width?: number;
  height?: number;
}

export interface Capture {
  /** A PNG data URL. */
  url: string;
  width: number;
  height: number;
  /** What was drawn: the compile it came from, and whether ceilings showed. */
  notes: string[];
}

export const preview3d: { capture: ((o: CaptureOptions) => Promise<Capture>) | null } = { capture: null };
