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

/** The body of `Message() { ... }`: where its braces open and close. */
function findMessage(src: string, message: string): { open: number; close: number } | null {
  const m = new RegExp(`^[ \\t]*${message}\\s*\\([^)]*\\)\\s*\\{`, "m").exec(src);
  if (!m) return null;
  const open = m.index + m[0].length - 1;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return { open, close: i };
  }
  return null;
}

/**
 * Add lines to a message, before its `propagate;`. The message is created,
 * in the messages section, if the class doesn't have it; `init` starts a new one.
 */
export function addToMessage(src: string, message: string, lines: string[], init: string[] = []): string {
  let found = findMessage(src, message);
  if (!found) {
    const body = [`   ${message}()`, "   {", ...init.map((l) => `      ${l}`), ...(init.length ? [""] : []), "      propagate;", "   }", "", ""].join("\n");
    const end = /^end\b/m.exec(src);
    if (!end) throw new Error("The class has no `end` line.");
    let at = end.index;
    if (!/^messages:/m.test(src)) {
      src = `${src.slice(0, at)}messages:\n\n${src.slice(at)}`;
      at += "messages:\n\n".length;
    }
    src = `${src.slice(0, at)}${body}${src.slice(at)}`;
    found = findMessage(src, message)!;
  }
  const inside = src.slice(found.open, found.close);
  const prop = inside.lastIndexOf("propagate;");
  let at: number;
  if (prop >= 0) {
    // At the start of the propagate line, after a blank line.
    at = found.open + inside.lastIndexOf("\n", prop) + 1;
  } else at = found.open + inside.lastIndexOf("\n") + 1;
  const text = lines.map((l) => `      ${l}\n`).join("");
  return src.slice(0, at) + text + src.slice(at);
}

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
