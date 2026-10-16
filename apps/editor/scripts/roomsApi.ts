// Dev-server stand-in for the Electron bridge, so the UI also runs in a plain
// browser: GET /api/rooms lists the rooms folder, GET/PUT /api/rooms/file?path=
// reads and writes one room source, /api/textures serves the texture library and
// /api/kod the server's room Kod. Bound to 127.0.0.1 by vite.config.ts.

import { readFile, writeFile } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import type { Plugin } from "vite";
import { readKodSources } from "../src/main/kod.ts";
import { listRooms, resolveInside } from "../src/main/roomsFs.ts";
import { listTextures, readResource, readTexture } from "../src/main/textures.ts";

export function roomsApi(dir: string, repoRoot: string): Plugin {
  return {
    name: "meridian-rooms-api",
    configureServer(server) {
      server.middlewares.use("/api/kod", (req, res) => {
        void (async () => {
          try {
            const url = new URL(req.url ?? "/", "http://localhost");
            send(res, 200, JSON.stringify(await readKodSources(url.searchParams.get("dir") ?? "", repoRoot)), "application/json");
          } catch (e) {
            send(res, 500, (e as Error).message, "text/plain");
          }
        })();
      });
      server.middlewares.use("/api/textures", (req, res) => {
        void (async () => {
          try {
            const url = new URL(req.url ?? "/", "http://localhost");
            const dir = url.searchParams.get("dir") ?? "";
            if (url.pathname === "/") send(res, 200, JSON.stringify(await listTextures(dir, repoRoot)), "application/json");
            else if (url.pathname === "/file") {
              const bytes = await readTexture(dir, url.searchParams.get("name") ?? "", repoRoot);
              res.statusCode = 200;
              res.setHeader("Content-Type", "application/octet-stream");
              res.end(bytes);
            } else if (url.pathname === "/resource") {
              const bytes = await readResource(dir, url.searchParams.get("name") ?? "", repoRoot);
              res.statusCode = 200;
              res.setHeader("Content-Type", "application/octet-stream");
              res.end(bytes);
            } else send(res, 404, "not found", "text/plain");
          } catch (e) {
            send(res, 500, (e as Error).message, "text/plain");
          }
        })();
      });
      server.middlewares.use("/api/rooms", (req, res) => {
        void (async () => {
          try {
            const url = new URL(req.url ?? "/", "http://localhost");
            if (url.pathname === "/" && req.method === "GET") {
              const rooms = await listRooms(dir);
              send(res, 200, JSON.stringify({ dir, rooms: rooms.map((r) => ({ id: r.path, path: r.path, name: r.name })) }), "application/json");
              return;
            }
            if (url.pathname === "/file") {
              const abs = resolveInside(dir, url.searchParams.get("path") ?? "");
              if (req.method === "GET") send(res, 200, await readFile(abs, "utf8"), "application/json");
              else if (req.method === "PUT") {
                await writeFile(abs, await body(req), "utf8");
                send(res, 204, "", "text/plain");
              } else send(res, 405, "method not allowed", "text/plain");
              return;
            }
            send(res, 404, "not found", "text/plain");
          } catch (e) {
            send(res, 500, (e as Error).message, "text/plain");
          }
        })();
      });
    },
  };
}

function send(res: import("node:http").ServerResponse, status: number, text: string, type: string): void {
  res.statusCode = status;
  res.setHeader("Content-Type", type);
  res.end(text);
}

function body(req: IncomingMessage): Promise<string> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolveBody(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
