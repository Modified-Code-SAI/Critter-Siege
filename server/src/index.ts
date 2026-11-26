import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type RawData } from "ws";
import { GAME_TITLE } from "@critter/shared";
import {
  RoomManager,
  type ClientSocketLike,
  type RoomManagerOptions,
} from "./roomManager.js";

export { RoomManager, type ClientSocketLike, type RoomManagerOptions };

/** Handle returned by startServer for inspecting the bound port and cleanly shutting down. */
export interface RunningServer {
  port: number;
  manager: RoomManager;
  close(): Promise<void>;
}

/** Format startup banner for Critter Siege room server logs. */
export function getServerBanner(): string {
  return `${GAME_TITLE} Server Ready`;
}

function rawDataToString(data: RawData): string {
  if (typeof data === "string") {
    return data;
  }
  if (Buffer.isBuffer(data)) {
    return data.toString("utf8");
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString("utf8");
  }
  return Buffer.from(data).toString("utf8");
}

function handleHttpRequest(req: IncomingMessage, res: ServerResponse): void {
  const method = req.method ?? "GET";
  const urlPath = (req.url ?? "/").split("?")[0];

  if (method === "GET" && urlPath === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, title: GAME_TITLE }));
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: false, error: "Not Found" }));
}

/**
 * Start the authoritative Critter Siege HTTP + WebSocket room server.
 * Serves `GET /health` and WebSocket room connections at `/ws`.
 */
export function startServer(
  port: number,
  options?: RoomManagerOptions,
): Promise<RunningServer> {
  const manager = new RoomManager(options);
  const server = http.createServer(handleHttpRequest);
  const wss = new WebSocketServer({ server, path: "/ws" });

  wss.on("connection", (ws) => {
    ws.on("message", (data) => {
      manager.handleMessage(ws, rawDataToString(data));
    });
    ws.on("close", () => {
      manager.handleDisconnect(ws);
    });
    ws.on("error", () => {
      manager.handleDisconnect(ws);
    });
  });

  let closed = false;
  const close = (): Promise<void> => {
    if (closed) {
      return Promise.resolve();
    }
    closed = true;
    manager.dispose();
    for (const client of wss.clients) {
      client.terminate();
    }
    return new Promise<void>((resolve, reject) => {
      wss.close((wssErr) => {
        if (wssErr) {
          reject(wssErr);
          return;
        }
        server.closeAllConnections();
        server.close((httpErr) => {
          if (httpErr) {
            reject(httpErr);
            return;
          }
          resolve();
        });
      });
    });
  };

  return new Promise<RunningServer>((resolve, reject) => {
    const onError = (err: Error): void => {
      manager.dispose();
      reject(err);
    };
    server.once("error", onError);
    server.listen(port, () => {
      server.off("error", onError);
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        void close().finally(() => {
          reject(new Error("Failed to determine bound TCP port."));
        });
        return;
      }
      const boundPort = (addr as AddressInfo).port;
      resolve({
        port: boundPort,
        manager,
        close,
      });
    });
  });
}

function isDirectEntrypoint(): boolean {
  if (process.env.VITEST === "true" || process.env.NODE_ENV === "test") {
    return false;
  }
  const entryArg = process.argv[1];
  if (!entryArg) {
    return false;
  }
  return path.resolve(entryArg) === path.resolve(fileURLToPath(import.meta.url));
}

if (isDirectEntrypoint()) {
  const listenPort = Number(process.env.PORT ?? 3001);
  void startServer(Number.isFinite(listenPort) ? listenPort : 3001).then(
    (running) => {
      console.log(`${getServerBanner()} on port ${running.port}`);
    },
    (err: unknown) => {
      console.error("Failed to start Critter Siege server:", err);
      process.exitCode = 1;
    },
  );
}
