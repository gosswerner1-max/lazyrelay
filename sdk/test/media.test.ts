import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { LazyRelay, LazyRelayError, guessContentType } from "../src/index.js";
import { FakeApi, KEY, parseMultipart } from "./fakeApi.js";

const api = new FakeApi();
let client: LazyRelay;
let dir: string;
// A real 1x1 PNG, so the bytes are recognisable end to end.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

beforeAll(async () => {
  await api.start();
  client = new LazyRelay({ apiKey: KEY, baseUrl: api.baseUrl });
  dir = mkdtempSync(join(tmpdir(), "lzr-sdk-"));
});
afterAll(async () => {
  rmSync(dir, { recursive: true, force: true });
  await api.stop();
});
beforeEach(() => api.reset(() => ({ status: 201, body: { id: "m1", url: "https://cdn.test/m1.png", altText: null } })));

describe("media.upload", () => {
  it("uploads a local file path as multipart with a `file` part", async () => {
    const path = join(dir, "photo.png");
    writeFileSync(path, PNG);
    const result = await client.media.upload(path);
    expect(result).toEqual({ id: "m1", url: "https://cdn.test/m1.png", altText: null });
    const req = api.last;
    expect(req.method).toBe("POST");
    expect(req.path).toBe("/api/media/upload");
    expect(req.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(String(req.headers["content-type"])).toMatch(/^multipart\/form-data; boundary=/);
    const parts = parseMultipart(req);
    expect(parts).toHaveLength(1);
    expect(parts[0].name).toBe("file");
    expect(parts[0].filename).toBe("photo.png");
    expect(parts[0].contentType).toBe("image/png");
    expect(Buffer.from(parts[0].data, "latin1").equals(PNG)).toBe(true);
  });

  it("sends altText as its own field", async () => {
    const result = await client.media.upload(new Blob([PNG], { type: "image/png" }), { altText: "A red square", filename: "sq.png" });
    expect(result.id).toBe("m1");
    const parts = parseMultipart(api.last);
    expect(parts.map((p) => p.name)).toEqual(["file", "altText"]);
    expect(parts[0].filename).toBe("sq.png");
    expect(parts[1].data).toBe("A red square");
  });

  it("accepts a Buffer with a filename", async () => {
    await client.media.upload(PNG, { filename: "buf.png" });
    const parts = parseMultipart(api.last);
    expect(parts[0]).toMatchObject({ name: "file", filename: "buf.png", contentType: "image/png" });
    expect(Buffer.from(parts[0].data, "latin1").equals(PNG)).toBe(true);
  });

  it("accepts a Uint8Array and an ArrayBuffer with a filename", async () => {
    await client.media.upload(new Uint8Array(PNG), { filename: "u8.png" });
    expect(parseMultipart(api.last)[0].filename).toBe("u8.png");
    const ab = PNG.buffer.slice(PNG.byteOffset, PNG.byteOffset + PNG.byteLength) as ArrayBuffer;
    await client.media.upload(ab, { filename: "ab.png" });
    expect(parseMultipart(api.last)[0].filename).toBe("ab.png");
  });

  it("uses the name of a File", async () => {
    await client.media.upload(new File([PNG], "named.png", { type: "image/png" }));
    expect(parseMultipart(api.last)[0].filename).toBe("named.png");
  });

  it("lets options.filename and options.contentType override", async () => {
    await client.media.upload(new File([PNG], "named.png", { type: "image/png" }), { filename: "other.jpg", contentType: "image/jpeg" });
    expect(parseMultipart(api.last)[0]).toMatchObject({ filename: "other.jpg", contentType: "image/jpeg" });
  });

  it("refuses a Buffer without a filename before any request", async () => {
    await expect(client.media.upload(PNG)).rejects.toMatchObject({ name: "LazyRelayError", kind: "validation", message: expect.stringContaining("filename") });
    expect(api.requests).toHaveLength(0);
  });

  it("reports a missing local file before any request", async () => {
    const err = await client.media.upload(join(dir, "nope.png")).catch((e) => e);
    expect(err).toBeInstanceOf(LazyRelayError);
    expect(err.message).toMatch(/File not found/);
    expect(api.requests).toHaveLength(0);
  });

  it("maps an API rejection", async () => {
    api.replyWith({ status: 400, body: { error: 'Unsupported or unrecognized file type "text/plain" - use an image' } });
    const err = await client.media.upload(Buffer.from("hello"), { filename: "a.txt" }).catch((e) => e);
    expect(err).toMatchObject({ status: 400, kind: "validation" });
  });

  it("maps a storage quota rejection (413) without retrying", async () => {
    api.replyWith({ status: 413, body: { error: "Storage quota reached" } });
    const err = await client.media.upload(PNG, { filename: "a.png" }).catch((e) => e);
    expect(err).toMatchObject({ status: 413, kind: "plan_limit", message: "Storage quota reached", retryable: false });
    expect(api.requests).toHaveLength(1);
  });
});

describe("guessContentType", () => {
  it("knows the formats the API accepts", () => {
    expect(guessContentType("a.JPG")).toBe("image/jpeg");
    expect(guessContentType("a.jpeg")).toBe("image/jpeg");
    expect(guessContentType("a.png")).toBe("image/png");
    expect(guessContentType("a.webp")).toBe("image/webp");
    expect(guessContentType("a.gif")).toBe("image/gif");
    expect(guessContentType("a.mp4")).toBe("video/mp4");
    expect(guessContentType("a.mov")).toBe("video/quicktime");
    expect(guessContentType("a.webm")).toBe("video/webm");
    expect(guessContentType("a.pdf")).toBe("application/pdf");
    expect(guessContentType("a.xyz")).toBe("application/octet-stream");
    expect(guessContentType("noext")).toBe("application/octet-stream");
  });
});
