[Reading 721 lines from start (total: 721 lines, 0 remaining)]

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import { isClientMessage, type ClientMessage, type ServerMessage } from "../shared/protocol.js";
import { BrowserSession, type BrowserSessionOptions } from "./cdp-session.js";
import { discoverChrome, findAgentProfile } from "./discover.js";
import { DownloadManager } from "./download-manager.js";
import { FileManager } from "./file-manager.js";
import { WorkspaceManager } from "./workspace-manager.js";
import { WorkspaceDataStore } from "./workspace-data.js";

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

async function readRequestBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += part.length;
    if (total > maxBytes) throw new Error("request too large");
    chunks.push(part);
  }
  return Buffer.concat(chunks);
}

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
  let session = new BrowserSession(sessionOpts);
  await session.connect();
  const workspaces = new WorkspaceManager();
  await workspaces.init();
  const workspaceData = new WorkspaceDataStore();
  const dataRoot = process.env.BROWSERFACE_DATA_ROOT ?? "/mnt/scratch/Browserface";
  const downloads = new DownloadManager(join(dataRoot, "Downloads"));
  await downloads.init();
  const files = new FileManager(dataRoot);
  await files.init();
  await session.setDownloadPath(downloads.completed);

  const staticDir = opts.staticDir ?? defaultStaticDir();
  const clients = new Set<WebSocket>();
  let activeWorkspaceId = "main";

  const httpServer = createServer(async (req, res) => {
    const pathname = req.url?.split("?")[0] ?? "/";
    if (pathname === "/library" && req.method === "GET") {
      res.statusCode = 200;
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.setHeader("cache-control", "no-store");
      res.end(JSON.stringify(await workspaceData.get(activeWorkspaceId)));
      return;
    }
    if (pathname === "/bookmarks" && req.method === "POST") {
      try {
        const body = await readRequestBody(req, 32 * 1024);
        const value = JSON.parse(body.toString("utf8")) as { url?: string; title?: string };
        if (!value.url || !/^https?:\/\//i.test(value.url)) throw new Error("valid http(s) url required");
        const url = value.url;
        const title = value.title?.trim() || url;
        const data = await workspaceData.update(activeWorkspaceId, (d) => {
          const old = d.bookmarks.find((x) => x.url === url);
          if (old) { old.title = title; return; }
          d.bookmarks.unshift({ id: Date.now().toString(36), url, title, createdAt: Date.now() });
          d.bookmarks = d.bookmarks.slice(0, 500);
        });
        res.statusCode = 201;
        res.setHeader("content-type", "application/json; charset=utf-8");
        res.end(JSON.stringify(data.bookmarks[0]));
      } catch (err) { res.statusCode = 400; res.end(err instanceof Error ? err.message : "bad request"); }
      return;
    }
    if (pathname === "/bookmarks" && req.method === "DELETE") {
      const url = new URL(req.url ?? "/", "http://browserface").searchParams.get("url");
      if (!url) { res.statusCode = 400; res.end("url required"); return; }
      await workspaceData.update(activeWorkspaceId, (d) => { d.bookmarks = d.bookmarks.filter((x) => x.url !== url); });
      res.statusCode = 204; res.end(); return;
    }
    if (pathname === "/session/save" && req.method === "POST") {
      await workspaceData.update(activeWorkspaceId, (d) => {
        d.sessionTabs = session.getTabs().filter((x) => /^https?:\/\//i.test(x.url)).map((x) => ({ title: x.title, url: x.url }));
      });
      res.statusCode = 204; res.end(); return;
    }
    if (pathname === "/session/restore" && req.method === "POST") {
      const data = await workspaceData.get(activeWorkspaceId);
      const saved = data.sessionTabs.filter((x) => /^https?:\/\//i.test(x.url));
      if (!saved.length) { res.statusCode = 404; res.end("no saved session"); return; }
      const replace = new URL(req.url ?? "/", "http://browserface").searchParams.get("replace") === "1";
      if (replace) {
        for (const tab of session.getTabs()) await session.closeTab(tab.id).catch(() => {});
      }
      for (const tab of saved) await session.newTab(tab.url);
      res.statusCode = 204; res.end(); return;
    }
    if (pathname === "/session/reopen" && req.method === "POST") {
      const data = await workspaceData.get(activeWorkspaceId);
      const closed = data.closedTabs[0];
      if (!closed) { res.statusCode = 404; res.end("no closed tab"); return; }
      await session.newTab(closed.url);
      await workspaceData.update(activeWorkspaceId, (d) => { d.closedTabs = d.closedTabs.slice(1); });
      res.statusCode = 204; res.end(); return;
    }
    if (pathname === "/groups" && req.method === "POST") {
      try {
        const body = await readRequestBody(req, 16 * 1024);
        const value = JSON.parse(body.toString("utf8")) as { name?: string };
        const name = value.name?.trim().slice(0, 64);
        if (!name) throw new Error("group name required");
        const tabs = session.getTabs().filter((x) => /^https?:\/\//i.test(x.url)).map((x) => ({ title: x.title, url: x.url }));
        const group = { id: Date.now().toString(36), name, tabs, createdAt: Date.now() };
        await workspaceData.update(activeWorkspaceId, (d) => { d.groups.unshift(group); d.groups = d.groups.slice(0, 100); });
        res.statusCode = 201; res.setHeader("content-type", "application/json; charset=utf-8"); res.end(JSON.stringify(group));
      } catch (err) { res.statusCode = 400; res.end(err instanceof Error ? err.message : "bad request"); }
      return;
    }
    if (pathname === "/groups/open" && req.method === "POST") {
      const body = await readRequestBody(req, 16 * 1024);
      const value = JSON.parse(body.toString("utf8")) as { id?: string };
      const data = await workspaceData.get(activeWorkspaceId);
      const group = data.groups.find((x) => x.id === value.id);
      if (!group) { res.statusCode = 404; res.end("group not found"); return; }
      for (const tab of group.tabs) await session.newTab(tab.url);
      res.statusCode = 204; res.end(); return;
    }
    if (pathname === "/groups" && req.method === "DELETE") {
      const id = new URL(req.url ?? "/", "http://browserface").searchParams.get("id");
      if (!id) { res.statusCode = 400; res.end("id required"); return; }
      await workspaceData.update(activeWorkspaceId, (d) => { d.groups = d.groups.filter((x) => x.id !== id); });
      res.statusCode = 204; res.end(); return;
    }
    if (pathname === "/workspaces" && req.method === "GET") {
      res.statusCode = 200;
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.setHeader("cache-control", "no-store");
      res.end(JSON.stringify({ active: activeWorkspaceId, workspaces: workspaces.list() }));
      return;
    }
    if (pathname === "/workspaces" && req.method === "POST") {
      try {
        const body = await readRequestBody(req, 16 * 1024);
        const value = JSON.parse(body.toString("utf8")) as { name?: string };
        const created = await workspaces.create(value.name ?? "");
        res.statusCode = 201;
        res.setHeader("content-type", "application/json; charset=utf-8");
        res.end(JSON.stringify(created));
      } catch (err) {
        res.statusCode = 400;
        res.end(err instanceof Error ? err.message : "bad request");
      }
      return;
    }
    if (pathname === "/workspaces/activate" && req.method === "POST") {
      try {
        const body = await readRequestBody(req, 16 * 1024);
        const value = JSON.parse(body.toString("utf8")) as { id?: string };
        if (!value.id || !switchWorkspace) throw new Error("workspace id required");
        await switchWorkspace(value.id);
        res.statusCode = 204;
        res.end();
      } catch (err) {
        res.statusCode = 400;
        res.end(err instanceof Error ? err.message : "workspace switch failed");
      }
      return;
    }
    if (pathname === "/workspaces" && req.method === "DELETE") {
      try {
        const url = new URL(req.url ?? "/", "http://browserface");
        const id = url.searchParams.get("id") ?? "";
        if (id === "main") throw new Error("main workspace cannot be removed");
        await workspaces.remove(id);
        res.statusCode = 204;
        res.end();
      } catch (err) {
        res.statusCode = 400;
        res.end(err instanceof Error ? err.message : "bad request");
      }
      return;
    }
    if (pathname === "/files" && req.method === "GET") {
      try {
        const url = new URL(req.url ?? "/", "http://browserface");
        const path = url.searchParams.get("path") ?? "";
        const entries = await files.list(path);
        res.statusCode = 200;
        res.setHeader("content-type", "application/json; charset=utf-8");
        res.setHeader("cache-control", "no-store");
        res.setHeader("x-content-type-options", "nosniff");
        res.end(JSON.stringify({ path, entries }));
      } catch (err) {
        res.statusCode = 400;
        res.end(err instanceof Error ? err.message : "bad request");
      }
      return;
    }
    if (pathname === "/files/download" && req.method === "GET") {
      try {
        const url = new URL(req.url ?? "/", "http://browserface");
        const path = url.searchParams.get("path") ?? "";
        const filePath = files.resolvePath(path);
        const s = await stat(filePath);
        if (!s.isFile()) throw new Error("not a file");
        const name = filePath.split("/").pop() ?? "download";
        res.statusCode = 200;
        res.setHeader("content-type", MIME[extname(name).toLowerCase()] ?? "application/octet-stream");
        res.setHeader("content-length", String(s.size));
        res.setHeader("content-disposition", "attachment; filename*=UTF-8''" + encodeURIComponent(name));
        res.setHeader("cache-control", "private, no-store");
        files.stream(path).pipe(res);
      } catch {
        res.statusCode = 404;
        res.end("not found");
      }
      return;
    }
    if (pathname === "/files" && req.method === "DELETE") {
      try {
        const url = new URL(req.url ?? "/", "http://browserface");
        await files.remove(url.searchParams.get("path") ?? "");
        res.statusCode = 204;
        res.end();
      } catch (err) {
        res.statusCode = 400;
        res.end(err instanceof Error ? err.message : "bad request");
      }
      return;
    }
    if (pathname === "/files/mkdir" && req.method === "POST") {
      try {
        const url = new URL(req.url ?? "/", "http://browserface");
        const path = url.searchParams.get("path") ?? "";
        const name = url.searchParams.get("name") ?? "";
        const target = path ? path + "/" + name : name;
        const created = await files.mkdir(target);
        res.statusCode = 201;
        res.setHeader("content-type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ path: created }));
      } catch (err) {
        res.statusCode = 400;
        res.end(err instanceof Error ? err.message : "bad request");
      }
      return;
    }
    if (pathname === "/files/rename" && req.method === "POST") {
      try {
        const body = await readRequestBody(req, 64 * 1024);
        const value = JSON.parse(body.toString("utf8")) as { path?: string; name?: string };
        const renamed = await files.rename(value.path ?? "", value.name ?? "");
        res.statusCode = 200;
        res.setHeader("content-type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ path: renamed }));
      } catch (err) {
        res.statusCode = 400;
        res.end(err instanceof Error ? err.message : "bad request");
      }
      return;
    }
    if (pathname === "/files/upload" && req.method === "POST") {
      try {
        const url = new URL(req.url ?? "/", "http://browserface");
        const saved = await files.writeUpload(
          url.searchParams.get("path") ?? "",
          url.searchParams.get("name") ?? "",
          req,
        );
        res.statusCode = 201;
        res.setHeader("content-type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ path: saved }));
      } catch (err) {
        res.statusCode = 400;
        res.end(err instanceof Error ? err.message : "upload failed");
      }
      return;
    }
    if (pathname === "/downloads" && req.method === "GET") {
      try {
        const files = await downloads.list();
        res.statusCode = 200;
        res.setHeader("content-type", "application/json; charset=utf-8");
        res.setHeader("cache-control", "no-store");
        res.setHeader("x-content-type-options", "nosniff");
        res.end(JSON.stringify({ files }));
      } catch { res.statusCode = 500; res.end("internal error"); }
      return;
    }
    if (pathname === "/downloads/file" && req.method === "GET") {
      try {
        const name = new URL(req.url ?? "/", "http://browserface").searchParams.get("name") ?? "";
        const filePath = downloads.pathFor(name);
        const s = await stat(filePath);
        res.statusCode = 200;
        res.setHeader("content-type", MIME[extname(name).toLowerCase()] ?? "application/octet-stream");
        res.setHeader("content-length", String(s.size));
        res.setHeader("content-disposition", `attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
        res.setHeader("cache-control", "private, no-store");
        downloads.stream(name).pipe(res);
      } catch { res.statusCode = 404; res.end("not found"); }
      return;
    }
    if (pathname === "/downloads/file" && req.method === "DELETE") {
      try {
        const name = new URL(req.url ?? "/", "http://browserface").searchParams.get("name") ?? "";
        await downloads.remove(name);
        res.statusCode = 204; res.end();
      } catch { res.statusCode = 404; res.end("not found"); }
      return;
    }
    if (pathname === "/healthz") {
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
          const action = msg.action;
          if (action.type === "closeTab") {
            const closing = session.getTabs().find((t) => t.id === action.tabId);
            if (closing && /^https?:\/\//i.test(closing.url)) {
              await workspaceData.update(activeWorkspaceId, (d) => {
                d.closedTabs = [{ title: closing.title, url: closing.url, closedAt: Date.now() }, ...d.closedTabs.filter((x) => x.url !== closing.url)].slice(0, 20);
              });
            }
          }
          await session.dispatch(action);
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

  const restoreSavedSessionIfNeeded = async (workspaceId: string, current: BrowserSession) => {
    if (process.env.BROWSERFACE_AUTO_RESTORE === "0") return;
    const currentHttp = current.getTabs().filter((x) => /^https?:\/\//i.test(x.url));
    if (currentHttp.length) return;
    const data = await workspaceData.get(workspaceId);
    const saved = data.sessionTabs.filter((x) => /^https?:\/\//i.test(x.url));
    if (!saved.length) return;
    for (const tab of saved.slice(0, 50)) await current.newTab(tab.url).catch(() => {});
  };

  await restoreSavedSessionIfNeeded(activeWorkspaceId, session);

  const bindSession = (current: BrowserSession) => {
    const screenshot = (msg: Parameters<BrowserSession["emit"]>[1] extends never ? never : any) => {
      const payload = encodeScreenshot(msg);
      for (const ws of clients) {
        if (ws.readyState !== ws.OPEN) continue;
        const frameBackpressureBytes = Math.max(FRAME_BACKPRESSURE_MIN_BYTES, payload.byteLength * 2);
        if (ws.bufferedAmount > frameBackpressureBytes) continue;
        ws.send(payload);
      }
    };
    const closed = () => {
      broadcast({ type: "error", message: "browser session closed" });
    };
    const page = async (msg: ServerMessage) => {
      broadcast(msg);
      if (msg.type === "page" && !msg.loading && /^https?:\/\//i.test(msg.url)) {
        await workspaceData.update(activeWorkspaceId, (data) => {
          const entry = { url: msg.url, title: msg.title, visitedAt: Date.now() };
          data.history = [entry, ...data.history.filter((x) => x.url !== msg.url)].slice(0, 1000);
        }).catch(() => {});
      }
    };
    current.on("screenshot", screenshot);
    current.on("page", page);
    const tabs = async (msg: ServerMessage) => {
      broadcast(msg);
      if (msg.type === "tabs") await workspaceData.update(activeWorkspaceId, (d) => {
        d.sessionTabs = msg.tabs.filter((x) => /^https?:\/\//i.test(x.url)).map((x) => ({ title: x.title, url: x.url }));
      }).catch(() => {});
    };
    current.on("tabs", tabs);
    current.on("visibility", broadcast);
    current.on("inactive", broadcast);
    current.on("hover", broadcast);
    current.on("selection", broadcast);
    current.on("findResult", broadcast);
    current.on("closed", closed);
    return () => {
      current.off("screenshot", screenshot);
      current.off("page", page);
      current.off("tabs", tabs);
      current.off("visibility", broadcast);
      current.off("inactive", broadcast);
      current.off("hover", broadcast);
      current.off("selection", broadcast);
      current.off("findResult", broadcast);
      current.off("closed", closed);
    };
  };

  let unbindSession = bindSession(session);
  let switchWorkspace: ((id: string) => Promise<void>) | null = null;

  switchWorkspace = async (id: string) => {
    if (id === activeWorkspaceId) return;
    const item = workspaces.get(id);
    const target = await workspaces.ensureRunning(item);
    const next = new BrowserSession({
      ...sessionOpts,
      target,
      port: undefined,
      host: undefined,
      targetId: undefined,
    });
    await next.connect();
    await restoreSavedSessionIfNeeded(id, next);
    await next.setDownloadPath(downloads.completed);
    const previous = session;
    unbindSession();
    session = next;
    unbindSession = bindSession(session);
    activeWorkspaceId = id;
    await previous.close();
    for (const ws of clients) {
      if (ws.readyState !== ws.OPEN) continue;
      const page = session.getPage();
      ws.send(JSON.stringify({ type: "ready", viewport: session.getViewport(), url: page.url, title: page.title }));
      ws.send(JSON.stringify({ type: "tabs", tabs: session.getTabs() }));
      ws.send(JSON.stringify({ type: "visibility", visible: session.getVisibility() }));
      const frame = await session.captureCurrentFrame().catch(() => null);
      if (frame && ws.readyState === ws.OPEN) ws.send(encodeScreenshot(frame));
    }
  };

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

[executed on device: ip-172-31-44-71 (13ee5edb-ae63-40e5-b176-f056db72d14f)]