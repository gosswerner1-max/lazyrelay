import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface Recorded {
  method: string;
  /** Path without the query string, with the /api prefix. */
  path: string;
  query: Record<string, string>;
  headers: IncomingHttpHeaders;
  raw: Buffer;
  /** Parsed JSON body, or undefined when there was none or it was not JSON. */
  json: unknown;
}

export interface Reply {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
  /** Send this text instead of JSON. */
  text?: string;
}

export type Handler = (req: Recorded, count: number) => Reply;

/** A real HTTP server standing in for the LazyRelay API. Mounted at /api like production. */
export class FakeApi {
  readonly requests: Recorded[] = [];
  private server: Server;
  private handler: Handler = () => ({ status: 200, body: {} });
  baseUrl = "";

  constructor() {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const raw = Buffer.concat(chunks);
        const url = new URL(req.url ?? "/", "http://localhost");
        let json: unknown;
        if ((req.headers["content-type"] ?? "").includes("application/json") && raw.length) {
          try {
            json = JSON.parse(raw.toString("utf8"));
          } catch {
            json = undefined;
          }
        }
        const recorded: Recorded = { method: req.method ?? "", path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers, raw, json };
        this.requests.push(recorded);
        const reply = this.handler(recorded, this.requests.length);
        const status = reply.status ?? 200;
        if (reply.text !== undefined) {
          res.writeHead(status, { "Content-Type": "text/plain", ...reply.headers });
          res.end(reply.text);
        } else if (status === 204) {
          res.writeHead(204, reply.headers);
          res.end();
        } else {
          res.writeHead(status, { "Content-Type": "application/json", ...reply.headers });
          res.end(JSON.stringify(reply.body ?? {}));
        }
      });
    });
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    this.baseUrl = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}/api`;
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections?.();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  reset(handler: Handler = () => ({ status: 200, body: {} })): void {
    this.requests.length = 0;
    this.handler = handler;
  }

  /** Answer every request with this reply. */
  replyWith(reply: Reply): void {
    this.handler = () => reply;
  }

  get last(): Recorded {
    return this.requests[this.requests.length - 1];
  }
}

/** Splits a multipart body into its parts (enough for tests: names, file names, bytes as latin1). */
export function parseMultipart(req: Recorded): Array<{ name: string; filename?: string; contentType?: string; data: string }> {
  const type = String(req.headers["content-type"] ?? "");
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/.exec(type);
  if (!type.startsWith("multipart/form-data") || !boundary) throw new Error(`not multipart: ${type}`);
  const marker = `--${boundary[1] ?? boundary[2]}`;
  const text = req.raw.toString("latin1");
  const parts: Array<{ name: string; filename?: string; contentType?: string; data: string }> = [];
  for (const chunk of text.split(marker).slice(1)) {
    if (chunk.startsWith("--")) break;
    const [head, ...rest] = chunk.replace(/^\r\n/, "").split("\r\n\r\n");
    const body = rest.join("\r\n\r\n").replace(/\r\n$/, "");
    const name = /name="([^"]*)"/.exec(head)?.[1] ?? "";
    const filename = /filename="([^"]*)"/.exec(head)?.[1];
    const contentType = /content-type:\s*([^\r\n]+)/i.exec(head)?.[1];
    parts.push({ name, filename, contentType, data: body });
  }
  return parts;
}

export const KEY = "lzr_live_TESTKEY0123456789abcdef";
