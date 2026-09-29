import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import { isClientMessage, type ClientMessage, type ServerMessage } from "../shared/protocol.js";
import { BrowserSession, type BrowserSessionOptions } from "./cdp-session.js";
import { discoverChrome, findAgentProfile } from "./discover.js";

export interface BridgeOptions extends BrowserSessionOptions {
  // HTTP/WebSocket bind address.
  listenHost?: string;
  listenPort?: number;
  // Override path to client static assets (defaults to bundled dist/client).
  staticDir?: string;
  // Discovery: when neither `target` nor `port` is set, attach to a Chrome
  // we discover. Default probes the agent profile only
  // (~/.browserface/chrome, brought up by `browser/start`); set
  // `discoverUserChrome: true` to fall back to the chrome://inspect-toggle
  // path against the user's own Chrome instead. (To skip discovery
  // entirely, just pass an explicit `target` or `host`+`port`.)
  discoverUserChrome?: boolean;
  // Optional cross-origin allowlist for embedded deployments. Same-origin and
  // requests without an Origin header remain allowed by default.
  allowedOrigins?: string[];
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".map": "application/json; charset=utf-8",
};

function defaultStaticDir(): string {
  // dist/server/bridge.js → ../client
  const here = fileURLToPath(import.meta.url);
  return resolve(here, "..", "..", "client");
}

export interface BridgeHandle {
  close: () => Promise<void>;
  port: number;
}

export async function startBridge(opts: BridgeOptions = {}): Promise<BridgeHandle> {
  const sessionOpts: BrowserSessionOptions = { ...opts };
  if (!sessionOpts.target && !sessionOpts.port) {
    if (opts.discoverUserChrome) {
      const ep = await discoverChrome({ log: (m) => console.log(m) });
      sessionOpts.target = ep.browserWsUrl;
      console.log(
        `[browserface] discovered user Chrome at ${ep.host}:${ep.port} (profile: ${ep.profileDir})`,
      );
    } else {
      const ep = await findAgentProfile();
      if (!ep) {
        throw new Error(
          "agent Chrome is not running.\n" +
            "  browser/face defaults to the dedicated agent profile at ~/.browserface/chrome.\n" +
            "  Run `browser/start` to bring it up (or invoke browser/face — its wrapper does this for you),\n" +
            "  or pass --discover to attach to your own Chrome instead.",
        );
      }
      sessionOpts.target = ep.browserWsUrl;
      console.log(
        `[browserface] attached to agent profile at ${ep.host}:${ep.port}`,
      );
    }
  }
  const session = new BrowserSession(sessionOpts);
  await session.connect();

  const staticDir = opts.staticDir ?? defaultStaticDir();
  const clients = new Set<WebSocket>();

  const httpServer = createServer((req, res) => {
    if ((req.url?.split("?")[0] ?? "/") === "/healthz") {
      res.statusCode = 200;
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.setHeader("cache-control", "no-store");
      res.setHeader("x-content-type-options", "nosniff");
      res.end(JSON.stringify({ status: "ok", service: "browserface" }));
      return;
    }
    handleStatic(req, res, staticDir).catch((err) => {
      console.error("[browserface] static error:", err);
      res.statusCode = 500;
      res.end("internal error");
    });
  });

  const allowedOrigins = new Set(opts.allowedOrigins ?? []);
  const wss = new WebSocketServer({
    server: httpServer,
    path: "/ws",
    // Reject oversized control messages before JSON parsing. Screenshot frames
    // are server-to-client and are not affected by this limit.
    maxPayload: 256 * 1024,
    verifyClient: (info: { origin: string; req: IncomingMessage }) => {
      const { origin, req } = info;
      if (!origin) return true;
      if (allowedOrigins.has(origin)) return true;
      const host = req.headers.host;
      if (!host) return false;
      return origin === `http://${host}` || origin === `https://${host}`;
    },
  });

  // Binary screenshot packet:
  // [4 bytes magic "BFR1"]
  // [4 bytes metadata JSON length, big-endian]
  // [N bytes UTF-8 JSON metadata]
  // [raw JPEG/PNG bytes]
  //
  // Control/state messages remain normal JSON WebSocket messages.
  // This removes the large base64+JSON copy on every video frame.
  const encodeScreenshot = (msg: Extract<ServerMessage, { type: "screenshot" }>): Buffer => {
    if (typeof msg.data !== "string") {
      throw new Error("server screenshot payload must be base64 string");
    }
    const image = Buffer.from(msg.data, "base64");
    const meta = Buffer.from(
      JSON.stringify({
        type: "screenshot",
        format: msg.format,
        width: msg.width,
        height: msg.height,
        deviceScaleFactor: msg.deviceScaleFactor,
        frame: msg.frame,
        capturedAt: msg.capturedAt,
      }),
      "utf8",
    );

    const packet = Buffer.allocUnsafe(12 + meta.length + image.length);
    packet.write("BFR1", 0, 4, "ascii");
    packet.writeUInt32BE(meta.length, 4);
    meta.copy(packet, 8);
    image.copy(packet, 8 + meta.length);
    return packet;
  };

  wss.on("connection", (ws, req) => {
    clients.add(ws);
    const remote = req.socket.remoteAddress ?? "unknown";
    let helloReceived = false;
    let actionWindowStart = Date.now();
    let actionCount = 0;
    let pendingActions = 0;
    let queue = Promise.resolve();

    const reject = (message: string) => {
      try { ws.send(JSON.stringify({ type: "error", message })); } catch {}
    };

    const send = (msg: ServerMessage) => {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify(msg));
      }
    };

    // Snap to whichever tab the user is actually looking at right now. Done
    // per-connection (not at server startup) because the user's foreground
    // tab in Chrome can change between when the bridge launches and when they
    // open the UI. If the active tab is already attached, this is a no-op.
    void (async () => {
      try {
        await session.syncToActiveTab();
      } catch (err) {
        console.error("[browserface] syncToActiveTab failed:", err);
      }
      const viewport = session.getViewport();
      const page = session.getPage();
      send({
        type: "ready",
        viewport,
        url: page.url,
        title: page.title,
      });
      const tabs = session.getTabs();
      if (tabs.length > 0) send({ type: "tabs", tabs });
      send({ type: "visibility", visible: session.getVisibility() });
      // Seed the UI with a current frame so it doesn't sit on the "Waiting for
      // first frame…" placeholder until the page happens to paint something.
      const frame = await session.captureCurrentFrame();
      if (frame && ws.readyState === ws.OPEN) {
        ws.send(encodeScreenshot(frame));
      }
    })();

    ws.on("message", (raw) => {
      const rawText = raw.toString();
      if (Buffer.byteLength(rawText, "utf8") > 256 * 1024) {
        reject("message too large");
        return;
      }
      let value: unknown;
      try {
        value = JSON.parse(rawText);
      } catch {
        reject("invalid json");
        return;
      }
      if (!isClientMessage(value)) {
        reject("invalid message");
        return;
      }
      const msg: ClientMessage = value;
      if (msg.type === "hello") {
        helloReceived = true;
        console.log(`[browserface] client connected from ${remote} as ${msg.role} (${msg.client})`);
        return;
      }
      if (!helloReceived) {
        reject("hello required");
        ws.close(1008, "hello required");
        return;
      }

      const now = Date.now();
      if (now - actionWindowStart >= 1000) {
        actionWindowStart = now;
        actionCount = 0;
      }
      actionCount++;
      if (actionCount > 240) {
        reject("rate limit exceeded");
        return;
      }

      if (pendingActions >= 32) {
        // Mouse motion is disposable; dropping it is preferable to building
        // latency. Other actions get an explicit backpressure error.
        if (msg.action.type === "mousemove") return;
        reject("action queue busy");
        return;
      }
      pendingActions++;
      queue = queue.then(async () => {
        try {
          await session.dispatch(msg.action);
          send({ type: "ack", id: msg.id });
        } catch (err) {
          send({
            type: "error",
            id: msg.id,
            message: err instanceof Error ? err.message : String(err),
          });
        } finally {
          pendingActions--;
        }
      }).catch((err) => {
        pendingActions--;
        console.error("[browserface] client action queue error:", err);
      });
    });

    ws.on("close", () => {
      clients.delete(ws);
      console.log(`[browserface] client disconnected from ${remote}`);
    });
  });

  const broadcast = (msg: ServerMessage) => {
    const payload = JSON.stringify(msg);
    for (const ws of clients) {
      if (ws.readyState === ws.OPEN) ws.send(payload);
    }
  };

  // Binary frames are deliberately kept to roughly one frame in flight.
  // Queueing old images only increases latency, so stale frames are dropped.
  const FRAME_BACKPRESSURE_MIN_BYTES = 512 * 1024;

  session.on("screenshot", (msg) => {
    const payload = encodeScreenshot(msg);

    for (const ws of clients) {
      if (ws.readyState !== ws.OPEN) continue;

      // Drop stale frames instead of allowing latency to accumulate.
      const frameBackpressureBytes = Math.max(FRAME_BACKPRESSURE_MIN_BYTES, payload.byteLength * 2);
      if (ws.bufferedAmount > frameBackpressureBytes) continue;

      ws.send(payload);
    }
  });
  session.on("page", broadcast);
  session.on("tabs", broadcast);
  session.on("visibility", broadcast);
  session.on("inactive", broadcast);
  session.on("hover", broadcast);
  session.on("selection", broadcast);
  session.on("findResult", broadcast);
  session.on("closed", () => {
    broadcast({ type: "error", message: "browser session closed" });
    for (const ws of clients) ws.close();
  });

  const port = opts.listenPort ?? 8768;
  const host = opts.listenHost ?? "127.0.0.1";
  await new Promise<void>((res) => httpServer.listen(port, host, res));
  const addr = httpServer.address();
  const boundPort = typeof addr === "object" && addr ? addr.port : port;
  console.log(`[browserface] listening on http://${host}:${boundPort}`);

  return {
    port: boundPort,
    close: async () => {
      for (const ws of clients) ws.close();
      await new Promise<void>((res) => wss.close(() => res()));
      await new Promise<void>((res) => httpServer.close(() => res()));
      await session.close();
    },
  };
}

async function handleStatic(req: IncomingMessage, res: ServerResponse, root: string) {
  const url = req.url || "/";
  if (url.startsWith("/ws")) return; // handled by WebSocket upgrade
  // Strip query/hash, default to index.html.
  const pathname = url.split("?")[0]?.split("#")[0] ?? "/";
  const requested = pathname === "/" ? "/index.html" : pathname;
  const safe = normalize(requested);
  const rootPath = resolve(root);
  const filePath = resolve(rootPath, "." + safe);
  if (filePath !== rootPath && !filePath.startsWith(rootPath + "/")) {
    res.statusCode = 403;
    res.end("forbidden");
    return;
  }
  try {
    const data = await readFile(filePath);
    const mime = MIME[extname(filePath).toLowerCase()] ?? "application/octet-stream";
    res.statusCode = 200;
    res.setHeader("content-type", mime);
    res.setHeader("cache-control", "no-store");
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("referrer-policy", "no-referrer");
    res.end(data);
  } catch {
    res.statusCode = 404;
    res.end("not found");
  }
}
