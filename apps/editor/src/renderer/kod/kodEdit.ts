// Changing a room class's exits: its `plExits = Cons([ ... ],plExits);` lines in
// CreateStandardExits, edited as text so the rest of the file stays as written
// (line endings included). Pure, without the DOM or the store: the editor holds
// the result until the room is saved, and the agent's kod_ tools use it too.
// ADR 0001 decision 5.
//
//   plExits = Cons([ 7, 26, RID_RAZA_INN, 8, 6, ROTATE_NONE ],plExits);   an exit
//   plExits = Cons([ 2, 5, ROOM_LOCKED_DOOR, some_message ],plExits);      a locked door
//
// room.kod SomethingTryGo reads them: the first entry for a square wins, and
// since Cons puts each in front, that is the last line written for it.

import { OpError } from "../ops/types.ts";
import { exitStatements, stripComments, type KodExit } from "./kodRooms.ts";

/** An exit as the editor edits it: a locked door when `dest` is null. */
export type ExitSpec = { row: number; col: number } & (
  | { dest: null; message?: string }
  | { dest: string; destRow: number; destCol: number; rotate?: string }
);

const ROTATE_NONE = "ROTATE_NONE";

/** A parsed exit as a spec to change; refused if part of it is written as an expression. */
export function exitSpec(e: KodExit): ExitSpec {
  if (e.dest === null) return { row: e.row, col: e.col, dest: null, ...(e.message ? { message: e.message } : {}) };
  if (e.destRow === undefined || e.destCol === undefined) throw new OpError(`The exit at Kod row ${e.row}, col ${e.col} works out where it leads in Kod (line ${e.line}): change it in the .kod file.`);
  return { row: e.row, col: e.col, dest: e.dest, destRow: e.destRow, destCol: e.destCol, ...(e.rotate ? { rotate: e.rotate } : {}) };
}

/** The fields between the brackets: "70, 13, ROOM_LOCKED_DOOR, marion_gate_warning". */
export function exitFields(e: ExitSpec): string {
  check(e);
  if (e.dest === null) return [e.row, e.col, "ROOM_LOCKED_DOOR", ...(e.message ? [e.message] : [])].join(", ");
  return [e.row, e.col, e.dest, e.destRow, e.destCol, e.rotate || ROTATE_NONE].join(", ");
}

function check(e: ExitSpec): void {
  const square = (n: number): boolean => Number.isInteger(n) && n >= 1 && n <= 999;
  if (!square(e.row) || !square(e.col)) throw new OpError(`Kod rows and columns are whole numbers from 1 (got row ${e.row}, col ${e.col}).`);
  if (e.dest === null) {
    if (e.message && !/^[A-Za-z_]\w*$/.test(e.message)) throw new OpError(`"${e.message}" isn't a resource name: a locked door's message is a name from the class's resources, such as marion_gate_warning.`);
    return;
  }
  if (!/^(RID_\w+|\d+)$/.test(e.dest)) throw new OpError(`"${e.dest}" isn't a room: give an RID_ constant (RID_MAR_INN) or a room number.`);
  if (!square(e.destRow) || !square(e.destCol)) throw new OpError(`Where the exit puts players is a Kod row and column from 1 (got ${e.destRow}, ${e.destCol}).`);
  // room.kod TranslateAngleChange: ROTATE_ turns the player, a smaller value (SET_ANGLE_NORTH) sets their facing.
  if (e.rotate && !/^([A-Za-z_]\w*|-?\d+)$/.test(e.rotate)) throw new OpError(`"${e.rotate}" isn't a turn: a constant such as ROTATE_NONE, ROTATE_90 or SET_ANGLE_NORTH, or a number.`);
}

/** The text's line ending, so added lines match it. */
function eolOf(text: string): string {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

/** Line number (1-based) of an offset. */
function lineOf(text: string, at: number): number {
  let n = 1;
  for (let i = text.indexOf("\n"); i >= 0 && i < at; i = text.indexOf("\n", i + 1)) n++;
  return n;
}

/** Another exit already on the square (not `except`): Kod would use only one of them. */
function taken(text: string, row: number, col: number, except: number): void {
  const list = exitStatements(stripComments(text));
  const other = list.findIndex((s, i) => i !== except && Number(s.fields[0]) === row && Number(s.fields[1]) === col);
  if (other >= 0) throw new OpError(`Kod row ${row}, col ${col} already has an exit (line ${lineOf(text, list[other]!.start)}).`);
}

function statement(text: string, index: number) {
  const s = exitStatements(stripComments(text))[index];
  if (!s) throw new OpError(`The class has no exit #${index + 1} (it was changed since).`);
  return s;
}

/** Change exit `index` (in file order, as parseKodRoom lists them). */
export function setExit(text: string, index: number, e: ExitSpec): string {
  const s = statement(text, index);
  taken(text, e.row, e.col, index);
  return `${text.slice(0, s.open + 1)} ${exitFields(e)} ${text.slice(s.close)}`;
}

/** Remove exit `index`, with its line if nothing else is on it. */
export function removeExit(text: string, index: number): string {
  const s = statement(text, index);
  const stripped = stripComments(text);
  const lineStart = text.lastIndexOf("\n", s.start - 1) + 1;
  const nl = text.indexOf("\n", s.end);
  const lineEnd = nl < 0 ? text.length : nl + 1;
  const alone = !stripped.slice(lineStart, s.start).trim() && !stripped.slice(s.end, lineEnd).trim();
  return alone ? text.slice(0, lineStart) + text.slice(lineEnd) : text.slice(0, s.start) + text.slice(s.end);
}

/**
 * Add an exit: on the line after the class's last exit, indented the same; or
 * in CreateStandardExits (made if the class has none) when it lists none yet.
 */
export function addExit(text: string, e: ExitSpec): string {
  taken(text, e.row, e.col, -1);
  const line = `plExits = Cons([ ${exitFields(e)} ],plExits);`;
  const list = exitStatements(stripComments(text));
  const last = list[list.length - 1];
  if (!last) return addToMessage(text, "CreateStandardExits", [line], ["plExits = $;"]);
  const lineStart = text.lastIndexOf("\n", last.start - 1) + 1;
  const indent = /^[ \t]*/.exec(text.slice(lineStart))![0];
  const nl = text.indexOf("\n", last.end);
  const eol = eolOf(text);
  if (nl < 0) return `${text}${eol}${indent}${line}`;
  return `${text.slice(0, nl + 1)}${indent}${line}${eol}${text.slice(nl + 1)}`;
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
  const eol = eolOf(src);
  src = src.replace(/\r\n/g, "\n");
  let found = findMessage(src, message);
  if (!found) {
    const body = [`   ${message}()`, "   {", ...init.map((l) => `      ${l}`), ...(init.length ? [""] : []), "      propagate;", "   }", "", ""].join("\n");
    const end = /^end\b/m.exec(src);
    if (!end) throw new OpError("The class has no `end` line.");
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
  const out = src.slice(0, at) + text + src.slice(at);
  return eol === "\n" ? out : out.replace(/\n/g, eol);
}
