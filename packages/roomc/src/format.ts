// Room sources are committed, so they are written for small diffs: one
// vertex, linedef, sector or thing per line.

import type { RoomSource } from "./source.ts";

const LIST_KEYS = new Set(["vertices", "linedefs", "sectors", "things"]);

export function formatRoomSource(src: RoomSource): string {
  const lines = ["{"];
  const entries = Object.entries(src).filter(([, v]) => v !== undefined);
  entries.forEach(([key, value], i) => {
    const comma = i < entries.length - 1 ? "," : "";
    if (LIST_KEYS.has(key) && Array.isArray(value) && value.length > 0) {
      lines.push(`  ${JSON.stringify(key)}: [`);
      value.forEach((item, j) => lines.push(`    ${JSON.stringify(item)}${j < value.length - 1 ? "," : ""}`));
      lines.push(`  ]${comma}`);
    } else {
      lines.push(`  ${JSON.stringify(key)}: ${JSON.stringify(value)}${comma}`);
    }
  });
  lines.push("}");
  return lines.join("\n") + "\n";
}

export function parseRoomSource(text: string): RoomSource {
  return JSON.parse(text) as RoomSource;
}
