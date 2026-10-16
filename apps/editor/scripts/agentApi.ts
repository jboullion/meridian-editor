// The web build's end of the agent link (the Electron app's is in main.ts):
// the agent endpoint, relaying calls to the open page over Vite's HMR socket.
// Writes agent-web.json beside the development app's data. scripts/dev.ts
// turns it off, since there the Electron app takes the calls.

import { mkdirSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import type { Plugin } from "vite";
import { PageCalls, startAgentEndpoint } from "../src/main/agentEndpoint.ts";
import { appDataDir, EDITOR_DEV_DATA } from "../src/main/agentFiles.ts";
import type { AgentReply } from "../src/main/agentProtocol.ts";

export function agentApi(dir: string): Plugin {
  return {
    name: "meridian-agent",
    apply: "serve",
    configureServer(server) {
      if (process.env.EDITOR_AGENT_WEB === "0") return;
      const calls = new PageCalls();
      server.ws.on("meridian:agent-reply", (data: { id: number; reply: AgentReply }) => calls.settle(data.id, data.reply));
      const folder = join(appDataDir(), EDITOR_DEV_DATA);
      mkdirSync(folder, { recursive: true });
      void startAgentEndpoint({
        kind: "web",
        file: join(folder, "agent-web.json"),
        roomsDir: () => dir,
        toId: (abs) => relative(dir, abs).split(sep).join("/"),
        fromId: (id) => resolve(dir, id),
        toPage: (call) =>
          calls.send((id) => {
            if (server.ws.clients.size === 0) return false;
            server.ws.send("meridian:agent", { id, call });
            return true;
          }),
      }).then((endpoint) => {
        server.httpServer?.on("close", endpoint.close);
        process.on("exit", endpoint.close);
      });
    },
  };
}
