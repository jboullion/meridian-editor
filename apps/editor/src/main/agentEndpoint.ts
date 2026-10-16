// The editor's end of the agent link: a small HTTP server on 127.0.0.1 that
// takes one call per POST (with the token from the endpoint file), passes it to
// the page, and answers with the page's reply. Shared by the Electron main
// process and the Vite dev server; each says how to reach its page and how its
// page names files (Electron: absolute paths; the web build: paths in the rooms folder).

import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { AgentCall, AgentReply, AgentState } from "./agentProtocol.ts";
import { writeEndpoint } from "./agentFiles.ts";
import { resolveInside } from "./roomsFs.ts";

export interface EndpointHost {
  kind: "electron" | "web";
  /** Where to write the endpoint file. */
  file: string;
  roomsDir(): string;
  /** A file's id in the page, from its absolute path, and back. */
  toId(abs: string): string;
  fromId(id: string): string;
  /** Send a call to the page and wait for its reply. */
  toPage(call: AgentCall): Promise<AgentReply>;
  /** Calls the host answers itself (the window's screenshot). */
  local?(call: AgentCall): Promise<AgentReply> | null;
}

const LIMIT = 64 * 1024 * 1024;

export async function startAgentEndpoint(host: EndpointHost): Promise<{ close(): void; url: string }> {
  const token = randomBytes(24).toString("hex");
  const server = createServer((req, res) => void handle(host, token, req, res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/agent`;
  const remove = writeEndpoint(host.file, { url, token, pid: process.pid, kind: host.kind });
  return {
    url,
    close: () => {
      remove();
      server.close();
    },
  };
}

async function handle(host: EndpointHost, token: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const reply = (status: number, body: AgentReply): void => {
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(body));
  };
  // Only the agent, with the token; never a web page (they send an Origin).
  if (req.method !== "POST" || req.url !== "/agent") return reply(404, { ok: false, error: "not found" });
  if (req.headers.origin || req.headers.authorization !== `Bearer ${token}`) return reply(403, { ok: false, error: "forbidden" });
  let call: AgentCall;
  try {
    call = JSON.parse(await readBody(req)) as AgentCall;
  } catch (e) {
    return reply(400, { ok: false, error: (e as Error).message });
  }
  try {
    reply(200, await dispatch(host, call));
  } catch (e) {
    reply(200, { ok: false, error: (e as Error).message });
  }
}

async function dispatch(host: EndpointHost, call: AgentCall): Promise<AgentReply> {
  const local = host.local?.(call);
  if (local) return local;
  if (call.op === "screenshot") return { ok: false, error: "Screenshots of the window need the desktop app; the web build can render the 3D view (render_3d) and the map (render_map)." };
  if (call.op === "load") call = { ...call, id: call.path ? host.toId(resolveInside(host.roomsDir(), call.path)) : null };
  if (call.op === "save" && call.path) {
    const abs = resolveInside(host.roomsDir(), call.path);
    call = { ...call, id: host.toId(abs) };
  }
  const out = await host.toPage(call);
  if (!out.ok) return out;
  if (call.op === "state" || call.op === "save") {
    const s = out.value as AgentState;
    return { ok: true, value: { ...s, roomsDir: host.roomsDir(), path: s.docId ? host.fromId(s.docId) : null } };
  }
  return out;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > LIMIT) {
        reject(new Error("request too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** Calls waiting for the page, by id. */
export class PageCalls {
  private next = 1;
  private readonly waiting = new Map<number, { resolve: (r: AgentReply) => void; timer: ReturnType<typeof setTimeout> }>();

  /** Send with `post` and wait for `settle` with the same id. */
  send(post: (id: number) => boolean, timeoutMs = 60_000): Promise<AgentReply> {
    const id = this.next++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        resolve({ ok: false, error: "The editor didn't answer in time." });
      }, timeoutMs);
      this.waiting.set(id, { resolve, timer });
      if (!post(id)) {
        clearTimeout(timer);
        this.waiting.delete(id);
        resolve({ ok: false, error: "No editor page is open to take the call." });
      }
    });
  }

  settle(id: number, reply: AgentReply): void {
    const w = this.waiting.get(id);
    if (!w) return;
    clearTimeout(w.timer);
    this.waiting.delete(id);
    w.resolve(reply);
  }
}
