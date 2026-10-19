// Writing a new room's Kod class (rooms/new/<room>.kod): a class like the
// editor's test room, and lines added to it where Kod expects them. Text
// edits only; the result is parsed again (parseKodRoom) to check it reads.

export interface NewRoomKod {
  className: string;
  /** The room's file name without .roo. */
  name: string;
  title: string;
  roomId: number;
  teleport: [number, number];
  baseLight: string;
  outsideFactor: number;
  terrain: string;
  noCombat: boolean;
}

export function newRoomKodText(o: NewRoomKod): string {
  return `// ${o.title} (meridian-editor rooms/new/${o.name}.room.json).
// tools/shards/install.ts copies this into the server's Kod tree.

////////////////////////////////////////////////////////////////////////////////
${o.className} is Room

constants:

   include blakston.khd

resources:

   room_name_${o.className} = "${o.title.replace(/"/g, "'")}"
   room_${o.className} = ${o.name}.roo

classvars:

   vrName = room_name_${o.className}

   viTeleport_row = ${o.teleport[0]}
   viTeleport_col = ${o.teleport[1]}

   viTerrain_Type = ${o.terrain}

properties:
${o.noCombat ? "\n   viPermanent_flags = ROOM_NO_COMBAT\n" : ""}
   prRoom = room_${o.className}
   piRoom_num = ${o.roomId}

   piBaseLight = ${o.baseLight}
   piOutside_factor = ${o.outsideFactor}

messages:

end
////////////////////////////////////////////////////////////////////////////////
`;
}

// Shared with the editor, which edits exits in the server's Kod too.
export { addToMessage } from "../../../apps/editor/src/renderer/kod/kodEdit.ts";

/** Set `name = value` in a section (classvars or properties), adding it if it isn't there. */
export function setVariable(src: string, section: "classvars" | "properties", name: string, value: string): string {
  if (/[\r\n]/.test(value)) throw new Error("A value is one line.");
  const start = new RegExp(`^${section}:[^\\n]*\\n`, "m").exec(src);
  if (!start) throw new Error(`The class has no ${section} section.`);
  const from = start.index + start[0].length;
  const next = /^(constants|resources|classvars|properties|messages):|^end\b/m.exec(src.slice(from));
  const to = next ? from + next.index : src.length;
  const body = src.slice(from, to);
  const line = new RegExp(`^([ \\t]*)${name}[ \\t]*=[^\\r\\n]*`, "m").exec(body);
  if (line) return src.slice(0, from) + body.slice(0, line.index) + `${line[1]}${name} = ${value}` + body.slice(line.index + line[0].length) + src.slice(to);
  // After the section's last line, before the blank lines that end it.
  const trimmed = body.replace(/\s*$/, "");
  return `${src.slice(0, from)}${trimmed}${trimmed ? "\n" : "\n"}   ${name} = ${value}\n\n${src.slice(to)}`;
}

/** The lines that differ, for showing an edit. */
export function changedLines(before: string, after: string): string[] {
  const a = new Set(before.split("\n"));
  return after.split("\n").filter((l) => !a.has(l) && l.trim());
}
