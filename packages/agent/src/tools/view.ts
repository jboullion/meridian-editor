// Pictures of the room for the agent to look at.

import { z } from "zod";
import { renderMap } from "../render/map.ts";
import { ImageOutput, index, tool } from "../tool.ts";

export const viewTools = [
  tool({
    name: "render_map",
    title: "Render the map",
    description:
      "A picture of the 2D map: sectors shaded by floor height (or ceiling or light), walls marked solid, open or blocked, the room box, Kod placements and index labels (sectors by default; add linedefs, vertices or things). Zoom in with bbox. Use it to check a layout after editing and to find items by eye.",
    input: {
      bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional().describe("[minX, minY, maxX, maxY] editor units; default the whole room"),
      colorBy: z.enum(["floor", "ceiling", "light"]).optional(),
      labels: z.array(z.enum(["sector", "linedef", "vertex", "thing"])).optional().describe('Default ["sector"]; [] for none'),
      highlight: z.object({ kind: z.enum(["sector", "linedef", "vertex", "thing"]), indices: z.array(index) }).optional(),
      size: z.number().int().min(256).max(2048).optional().describe("Longest side in pixels (default 1024)"),
      kod: z.boolean().optional().describe("Show Kod placements (default true)"),
    },
    annotations: { readOnlyHint: true },
    run: async (s, a) => {
      const { png, info } = await renderMap(s, a);
      return new ImageOutput(png, { revision: s.revision(), ...info });
    },
  }),
];
