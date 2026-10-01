// The real socket code (ws, the pinned address lookup, the message size cap, publish and read-back) against a throwaway
// relay on THIS machine's loopback with its own self-made certificate. No real relay and no outside network is touched.
// Skipped on a machine without openssl.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer } from "ws";
import { finalizeEvent, generateSecretKey } from "nostr-tools/pure";
import { openRelaySocket, publishToRelay, readFromRelay, MAX_MESSAGE_BYTES } from "./nostrRelay.js";

let haveOpenssl = true;
let dir = "";
let cert = "";
let key = "";
try {
  dir = mkdtempSync(join(tmpdir(), "lr-nostr-"));
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(dir, "k.pem"), "-out", join(dir, "c.pem"), "-days", "1", "-subj", "/CN=pinme.example.test", "-addext", "subjectAltName=DNS:pinme.example.test"], { stdio: "ignore" });
  cert = readFileSync(join(dir, "c.pem"), "utf8");
  key = readFileSync(join(dir, "k.pem"), "utf8");
} catch {
  haveOpenssl = false;
}

const HOST = "pinme.example.test"; // does not exist in DNS: it only works if the connection is pinned to the approved address
let server: Server;
let port = 0;
let serverSaw: string[] = [];
let mode: "relay" | "flood" = "relay";

beforeAll(async () => {
  if (!haveOpenssl) return;
  server = createServer({ key, cert });
  const wss = new WebSocketServer({ server });
  wss.on("connection", (socket) => {
    if (mode === "flood") socket.send("x".repeat(MAX_MESSAGE_BYTES + 10));
    socket.on("message", (data) => {
      const text = data.toString();
      serverSaw.push(text);
      const msg = JSON.parse(text) as unknown[];
      if (msg[0] === "EVENT") socket.send(JSON.stringify(["OK", (msg[1] as { id: string }).id, true, ""]));
      if (msg[0] === "REQ") socket.send(JSON.stringify(["EOSE", msg[1]]));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as { port: number }).port;
});
afterAll(async () => {
  if (haveOpenssl) await new Promise<void>((resolve) => server.close(() => resolve()));
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const url = () => `wss://${HOST}:${port}/`;

describe.skipIf(!haveOpenssl)("the real relay socket", () => {
  it("connects only to the pinned address (the name itself does not resolve) and passes messages both ways", async () => {
    mode = "relay";
    const conn = await openRelaySocket(url(), ["127.0.0.1"], { ca: cert });
    const got = new Promise<string>((resolve) => conn.onMessage(resolve));
    conn.send(JSON.stringify(["REQ", "s1", { kinds: [1] }]));
    expect(JSON.parse(await got)).toEqual(["EOSE", "s1"]);
    conn.close();
  });

  it("will not connect without a pinned address it can use, or to a server whose certificate it does not trust", async () => {
    await expect(openRelaySocket(url(), [], { ca: cert })).rejects.toThrow("relay unreachable");
    await expect(openRelaySocket(url(), ["127.0.0.1"])).rejects.toThrow("relay unreachable"); // self made certificate, no ca given
  });

  it("an error never carries the address or any text from the other side", async () => {
    const err = (await openRelaySocket(url(), ["127.0.0.1"]).catch((e: Error) => e)) as Error;
    expect(err.message).toBe("relay unreachable");
  });

  it("drops a connection whose message is bigger than the cap", async () => {
    mode = "flood";
    const conn = await openRelaySocket(url(), ["127.0.0.1"], { ca: cert });
    const messages: string[] = [];
    conn.onMessage((m) => messages.push(m));
    await new Promise<void>((resolve) => conn.onClose(resolve));
    expect(messages).toEqual([]);
    mode = "relay";
  });

  it("publishToRelay and readFromRelay work over the real socket and leave nothing open", async () => {
    mode = "relay";
    serverSaw = [];
    const connector = () => openRelaySocket(url(), ["127.0.0.1"], { ca: cert });
    const relay = { url: "wss://pinme.example.test", host: HOST, addresses: ["127.0.0.1"] };
    const event = finalizeEvent({ kind: 1, content: "over a real socket", tags: [], created_at: Math.floor(Date.now() / 1000) }, generateSecretKey());
    expect(await publishToRelay(connector, relay, event, 2000)).toEqual({ relay: relay.url, reachable: true, accepted: true, code: null });
    const read = await readFromRelay(connector, relay, { ids: [event.id] }, 2000);
    expect(read).toEqual({ relay: relay.url, reachable: true, events: [] }); // reachable, and the throwaway relay stores nothing
    expect(serverSaw.map((m) => JSON.parse(m)[0])).toEqual(["EVENT", "REQ"]); // each over its own connection
  });
});
