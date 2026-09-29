import type {
  ClientAction,
  ClientActionMessage,
  ServerMessage,
} from "../shared/protocol.js";

export type ConnectionState = "connecting" | "connected" | "disconnected" | "error";

// WebSocket transport between the client UI and the bridge server. Owns the
// connection lifecycle (auto-reconnect with exponential backoff up to 5s),
// the action-id sequencer, and dispatch of incoming server messages back to
// the caller. Status transitions go to setStatus so the caller can update
// whatever indicator it wants — the transport itself doesn't know about UI.
export interface BridgeOptions {
  setStatus: (state: ConnectionState) => void;
  onMessage: (msg: ServerMessage) => void;
}

export interface BridgeClient {
  connect: () => void;
  // Returns the action id (so the caller can correlate ack/error responses)
  // or null if the socket isn't open. Actions queued before the socket opens
  // are dropped — the caller is expected to be reactive to setStatus.
  send: (action: ClientAction) => string | null;
}

export function createBridge(opts: BridgeOptions): BridgeClient {
  let ws: WebSocket | null = null;
  let retryDelay = 500;
  let nextActionId = 1;

  function connect() {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const sock = new WebSocket(`${proto}//${location.host}/ws`);
    // Screenshot frames are sent as raw binary packets. Control messages
    // remain text JSON.
    sock.binaryType = "arraybuffer";
    ws = sock;
    opts.setStatus("connecting");

    sock.addEventListener("open", () => {
      retryDelay = 500;
      opts.setStatus("connected");
      sock.send(
        JSON.stringify({
          type: "hello",
          client: `human-${Math.random().toString(36).slice(2, 8)}`,
          role: "human",
        }),
      );
    });

    sock.addEventListener("message", (ev) => {
      // Binary screenshot packet:
      // "BFR1" + uint32 metadata length + JSON metadata + image bytes.
      if (typeof ev.data !== "string") {
        try {
          const bytes =
            ev.data instanceof ArrayBuffer
              ? new Uint8Array(ev.data)
              : new Uint8Array(ev.data as ArrayBufferLike);

          if (bytes.byteLength < 12) return;

            const magic = String.fromCharCode(bytes[0]!, bytes[1]!, bytes[2]!, bytes[3]!);

          if (magic !== "BFR1") return;

          const view = new DataView(
            bytes.buffer,
            bytes.byteOffset,
            bytes.byteLength,
          );

          const metaLength = view.getUint32(4, false);
          const metaStart = 8;
          const imageStart = metaStart + metaLength;

          if (
            metaLength <= 0 ||
            imageStart > bytes.byteLength
          ) {
            return;
          }

          const metaBytes = bytes.subarray(metaStart, imageStart);
          const meta = JSON.parse(new TextDecoder().decode(metaBytes)) as {
            type?: string;
            format?: "png" | "jpeg";
            width?: number;
            height?: number;
            deviceScaleFactor?: number;
            frame?: number;
            capturedAt?: number;
          };

          if (
            meta.type !== "screenshot" ||
            (meta.format !== "jpeg" && meta.format !== "png") ||
            typeof meta.width !== "number" ||
            typeof meta.height !== "number" ||
            typeof meta.deviceScaleFactor !== "number" ||
            typeof meta.frame !== "number" ||
            typeof meta.capturedAt !== "number"
          ) {
            return;
          }

          const image = bytes.slice(imageStart);
          opts.onMessage({
            type: "screenshot",
            data: image.buffer,
            format: meta.format,
            width: meta.width,
            height: meta.height,
            deviceScaleFactor: meta.deviceScaleFactor,
            frame: meta.frame,
            capturedAt: meta.capturedAt,
          } as ServerMessage);

          return;
        } catch {
          return;
        }
      }

      let msg: ServerMessage;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      opts.onMessage(msg);
    });

    sock.addEventListener("close", () => {
      ws = null;
      opts.setStatus("disconnected");
      setTimeout(connect, retryDelay);
      retryDelay = Math.min(5000, retryDelay * 2);
    });

    sock.addEventListener("error", () => {
      opts.setStatus("error");
    });
  }

  function send(action: ClientAction): string | null {
    if (!ws || ws.readyState !== WebSocket.OPEN) return null;
    const id = String(nextActionId++);
    const msg: ClientActionMessage = { type: "action", id, action };
    ws.send(JSON.stringify(msg));
    return id;
  }

  return { connect, send };
}
