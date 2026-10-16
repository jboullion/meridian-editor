// Switching between working on files (headless) and on the room open in the
// running editor (live).

import { z } from "zod";
import { findEditor, LiveSession } from "../live.ts";
import { OpError, type Session } from "../session.ts";
import { tool, type ToolDef } from "../tool.ts";
import { status } from "./document.ts";

export interface SessionHolder {
  session: Session;
  /** The file session, kept while attached so detaching goes back to it. */
  headless: Session;
}

export function connectionTools(holder: SessionHolder): ToolDef[] {
  return [
    tool({
      name: "connect_editor",
      title: "Work in the running editor",
      description:
        "Attach to the room editor the user has open (the desktop app, or the web build's page). From then on every tool works on the room open there: the user sees each change, and each tool call is one undo step in the editor. The 3D view, screenshots and the view tools need this. With bring, the room open here goes to the editor (as unsaved).",
      input: { bring: z.boolean().optional(), discard: z.boolean().optional().describe("With bring: replace a room with unsaved changes in the editor") },
      raw: true,
      run: async (_s, { bring, discard }) => {
        if (holder.session.backend === "live") {
          await holder.session.sync?.();
          return { note: "Already connected.", ...status(holder.session) };
        }
        const found = await findEditor();
        if ("error" in found) throw new OpError(found.error);
        const live = new LiveSession(found.link, holder.headless.repoRoot);
        await live.sync();
        const here = holder.headless;
        const notes: string[] = [];
        if (bring && here.hasRoom()) {
          if (live.hasRoom() && live.dirty() && !discard) throw new OpError(`The editor has unsaved changes to ${live.doc()?.name}: ask the user, or pass discard: true.`);
          live.load(here.doc()!, here.room(), here.dirty() ? null : here.room());
          await live.flush();
          await live.sync();
          notes.push(`Opened ${here.doc()?.name} in the editor.`);
        } else if (here.hasRoom() && here.dirty()) {
          notes.push(`${here.doc()?.name} has unsaved changes here; disconnect_editor goes back to it.`);
        }
        holder.session = live;
        return { connected: found.link.kind, ...(notes.length ? { notes } : {}), ...status(live) };
      },
    }),
    tool({
      name: "disconnect_editor",
      title: "Work on files again",
      description: "Stop working in the editor and go back to working on room files here (the room open before connecting, if any).",
      input: {},
      raw: true,
      run: async () => {
        holder.session = holder.headless;
        return status(holder.session);
      },
    }),
  ];
}
