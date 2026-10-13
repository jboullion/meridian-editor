// Compiles a room off the UI thread: big rooms take long enough to stutter a drag.

import { getProfile, type TargetName } from "@meridian-editor/roo";
import { CompileError, compileRoom, type RoomSource } from "@meridian-editor/roomc";
import type { CompileReply } from "./compiler.ts";

self.onmessage = (e: MessageEvent<{ id: number; room: RoomSource; target: TargetName }>) => {
  const { id, room, target } = e.data;
  const started = performance.now();
  let reply: CompileReply;
  try {
    const result = compileRoom(room, getProfile(target));
    reply = {
      id,
      ok: true,
      file: result.file,
      bytes: result.bytes,
      origin: result.origin,
      diagnostics: result.diagnostics,
      ms: performance.now() - started,
    };
  } catch (err) {
    const diagnostics = err instanceof CompileError ? err.diagnostics : [{ severity: "error" as const, message: (err as Error).message }];
    reply = { id, ok: false, diagnostics, ms: performance.now() - started };
  }
  (self as unknown as Worker).postMessage(reply, reply.ok ? [reply.bytes.buffer] : []);
};
