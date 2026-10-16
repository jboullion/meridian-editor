// A session on the room open in a running editor. Before each tool call it
// reads the editor's state; the tool works on that room as it would headless;
// afterwards the changes go back as one undo step in the editor ("Agent: …"
// in its status bar). If the user edited the room meanwhile, the editor
// refuses the change and the tool reports it.

import type { RoomSource } from "@meridian-editor/roomc";
import type { TargetName } from "@meridian-editor/roo";
import type { AgentCall, AgentEndpoint, AgentReply, AgentState } from "../../../apps/editor/src/main/agentProtocol.ts";
import { runningEndpoints } from "../../../apps/editor/src/main/agentFiles.ts";
import { HeadlessSession, OpError, roomName, type AgentPrefs, type DocRef, type EditorLink, type Selection } from "./session.ts";

export class HttpLink implements EditorLink {
  readonly kind: "electron" | "web";
  private readonly endpoint: AgentEndpoint;

  constructor(endpoint: AgentEndpoint) {
    this.endpoint = endpoint;
    this.kind = endpoint.kind;
  }

  async call<T>(call: AgentCall, timeoutMs = 90_000): Promise<T> {
    let res: Response;
    try {
      res = await fetch(this.endpoint.url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.endpoint.token}` },
        body: JSON.stringify(call),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      throw new OpError(`Can't reach the editor (${(e as Error).message}). Is it still running? disconnect_editor works on files instead.`);
    }
    const reply = (await res.json()) as AgentReply;
    if (!reply.ok) throw new OpError(reply.error);
    return reply.value as T;
  }
}

/** A running editor that answers, trying the likeliest first (Electron, then the web build). */
export async function findEditor(): Promise<{ link: HttpLink; state: AgentState } | { error: string }> {
  const found = runningEndpoints();
  if (!found.length) return { error: "No editor is running. Start it with npm run editor (or npm run editor:web and open the page)." };
  const errors: string[] = [];
  for (const e of found) {
    const link = new HttpLink(e);
    try {
      return { link, state: await link.call<AgentState>({ op: "state" }, 5000) };
    } catch (err) {
      errors.push(`${e.kind}: ${(err as Error).message}`);
    }
  }
  return { error: `Found an editor but it didn't answer: ${errors.join("; ")}` };
}

export class LiveSession extends HeadlessSession {
  override readonly backend = "live" as const;
  private readonly link: EditorLink;
  private state: AgentState | null = null;
  /** The room as the editor has it after this call's loads; edits since go back as one step. */
  private base: RoomSource | null = null;
  private labels: string[] = [];
  private loads = 0;
  private loadedSaved = false;
  /** Calls to send, in order, besides the edit itself. */
  private before: AgentCall[] = [];
  private after: AgentCall[] = [];

  constructor(link: EditorLink, repoRoot: string) {
    super("", repoRoot);
    this.link = link;
  }

  override editor(): EditorLink {
    return this.link;
  }

  async sync(): Promise<void> {
    const s = await this.link.call<AgentState>({ op: "state" });
    this.state = s;
    this._roomsDir = s.roomsDir;
    this._doc = s.name ? { path: s.path, name: s.name } : null;
    this._room = s.room;
    this.base = s.room;
    this._target = s.target;
    if (JSON.stringify(s.prefs) !== JSON.stringify(this._prefs)) super.setPrefs(s.prefs);
    this._selection = s.selection;
    if (s.name && s.kodClass) this.kodPicked[s.name] = s.kodClass;
    this.labels = [];
    this.loads = 0;
    this.before = [];
    this.after = [];
  }

  async flush(): Promise<void> {
    const s = this.state;
    if (!s) return;
    let rev = s.revision;
    for (const c of this.before) {
      const r = await this.link.call<{ revision?: number }>(c);
      if (r?.revision !== undefined) rev = r.revision;
    }
    if (this._room && this._room !== this.base) {
      await this.link.call({ op: "replace", label: this.labels.join(", ") || "edit", room: this._room, ifRevision: rev });
    }
    for (const c of this.after) await this.link.call(c);
    this.before = [];
    this.after = [];
    this.labels = [];
    this.state = null;
  }

  private live(): AgentState {
    if (!this.state) throw new OpError("Not synced with the editor.");
    return this.state;
  }

  override dirty(): boolean {
    const changed = this._room !== this.base;
    if (this.loads) return changed || !this.loadedSaved;
    return this.live().dirty || changed;
  }

  override revision(): number {
    return this.live().revision + this.loads + (this._room !== this.base ? 1 : 0);
  }

  override undoDepth(): number {
    return this.loads ? (this._room !== this.base ? 1 : 0) : this.live().undoDepth + (this._room !== this.base ? 1 : 0);
  }

  override redoDepth(): number {
    return this._room !== this.base || this.loads ? 0 : this.live().redoDepth;
  }

  override history(): string[] {
    return this.labels.length ? [`(this call) ${this.labels.join(", ")}`] : [];
  }

  override load(doc: DocRef, room: RoomSource, saved: RoomSource | null): void {
    this.before.push({ op: "load", path: doc.path, name: doc.name, room, saved: saved !== null });
    this._doc = doc;
    this._room = room;
    this.base = room;
    this._selection = null;
    this.issues = [];
    this.labels = [];
    this.loads++;
    this.loadedSaved = saved !== null;
  }

  override apply(label: string, fn: (room: RoomSource) => RoomSource): boolean {
    const room = this.room();
    const next = fn(room);
    if (next === room) return false;
    this._room = next;
    this.labels.push(label);
    return true;
  }

  override async transaction<T>(label: string, fn: () => Promise<T>): Promise<T> {
    const start = this._room;
    const labels = this.labels;
    try {
      const out = await fn();
      if (this._room !== start) this.labels = [...labels, label];
      return out;
    } catch (e) {
      this._room = start;
      this.labels = labels;
      throw e;
    }
  }

  override async undo(): Promise<string | null> {
    await this.flush();
    const r = await this.link.call<{ changed: boolean }>({ op: "undo" });
    await this.sync();
    return r.changed ? "the last step in the editor" : null;
  }

  override async redo(): Promise<string | null> {
    await this.flush();
    const r = await this.link.call<{ changed: boolean }>({ op: "redo" });
    await this.sync();
    return r.changed ? "the last undone step in the editor" : null;
  }

  override async save(path?: string): Promise<string> {
    await this.flush();
    const rel = path && (path.endsWith(".json") ? path : `${path}.room.json`);
    const s = await this.link.call<AgentState>({ op: "save", ...(rel ? { path: rel, name: roomName(rel) } : {}) });
    await this.sync();
    if (!s.path) throw new OpError("The editor saved the room but didn't say where.");
    return s.path;
  }

  override setTarget(target: TargetName): void {
    this._target = target;
    this.after.push({ op: "target", target });
  }

  override setPrefs(prefs: AgentPrefs): void {
    super.setPrefs(prefs);
    this.after.push({ op: "prefs", prefs });
  }

  override select(selection: Selection | null): void {
    super.select(selection);
    this.after.push({ op: "select", selection: this._selection });
  }

  override pickKodClass(className: string): void {
    super.pickKodClass(className);
    this.after.push({ op: "kodClass", className });
  }
}
