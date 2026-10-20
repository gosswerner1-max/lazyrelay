// POST /migrate/csv through the real route. Login is mocked, the database is the in-memory fake.
// Every CSV here follows a STATED layout or is a hand-made edge case. None is a real Buffer or Hootsuite export.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";
import express from "express";
import { tables } from "../../testFakeSupabase.js";

const auth = vi.hoisted(() => ({ accountId: "acc1", method: "jwt" as "jwt" | "apiKey" }));
vi.mock("../auth.js", async () => {
  const f = await import("../../testFakeSupabase.js");
  return {
    requireAuth: (req: any, _res: any, next: any) => {
      req.accountId = auth.accountId;
      req.userId = `user-of-${auth.accountId}`;
      req.authMethod = auth.method;
      req.db = { from: (t: string) => f.makeBuilder(t) };
      next();
    },
    requireHumanAuth: (req: any, res: any, next: any) => (req.authMethod === "apiKey" ? res.status(403).json({ error: "human only" }) : next()),
  };
});
vi.mock("../rateLimit.js", () => ({ tieredRateLimit: (_req: any, _res: any, next: any) => next() }));
vi.mock("../../supabase.js", async () => {
  const f = await import("../../testFakeSupabase.js");
  return { supabase: { from: (t: string) => f.makeBuilder(t) } };
});

const { buildMigrateCsvRouter, csvMigrationJsonParser } = await import("./migrateCsv.routes.js");

const app = () => {
  const a = express();
  a.use("/migrate/csv", ...csvMigrationJsonParser);
  a.use(express.json());
  a.use(buildMigrateCsvRouter());
  return a;
};

// STATED Buffer layout, not a real export.
const FILE = "Text,Link,Posting Time\nFirst post,https://example.com/1,2099-05-17 14:30\nSecond post,,2020-01-01 10:00\n";
const upload = (csv: string | Buffer, fields: Record<string, string> = {}) => {
  let r = request(app()).post("/migrate/csv").attach("file", Buffer.isBuffer(csv) ? csv : Buffer.from(csv, "utf8"), { filename: "export.csv", contentType: "text/csv" });
  for (const [k, v] of Object.entries(fields)) r = r.field(k, v);
  return r;
};
const draftCount = () => (tables.scheduled_posts ?? []).length;
let accountCounter = 0;

beforeEach(() => {
  for (const k of Object.keys(tables)) delete tables[k];
  auth.accountId = `acc${++accountCounter}`;
  auth.method = "jwt";
  process.env.CSV_MIGRATION_ENABLED = "true";
});
afterEach(() => {
  delete process.env.CSV_MIGRATION_ENABLED;
  vi.restoreAllMocks();
});

describe("the feature flag", () => {
  it("answers 404 for every step while CSV_MIGRATION_ENABLED is not exactly true", async () => {
    for (const value of [undefined, "", "false", "1", "TRUE"]) {
      if (value === undefined) delete process.env.CSV_MIGRATION_ENABLED;
      else process.env.CSV_MIGRATION_ENABLED = value;
      expect((await upload(FILE)).status).toBe(404);
      expect((await upload(FILE, { step: "confirm" })).status).toBe(404);
    }
    expect(draftCount()).toBe(0);
  });
});

describe("who may call it", () => {
  it("refuses an API key: a signed-in person only", async () => {
    auth.method = "apiKey";
    expect((await upload(FILE)).status).toBe(403);
    expect(draftCount()).toBe(0);
  });
});

describe("step 1: preview", () => {
  it("parses and reports, and creates nothing", async () => {
    const r = await upload(FILE);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      detected: "buffer",
      columns: { text: "Text", link: "Link", time: "Posting Time" },
      needsMapping: false,
      rowsTotal: 2,
      rowsUsable: 2,
      noUsableDate: 1,
      dateOrder: "not_applicable",
      timezone: "UTC",
    });
    expect(r.body.rows).toHaveLength(2);
    expect(r.body.rows[0]).toMatchObject({ row: 2, text: "First post", link: "https://example.com/1", plannedDate: "2099-05-17" });
    expect(r.body.fileFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(draftCount()).toBe(0);
  });

  it("accepts the same file as JSON text", async () => {
    const r = await request(app()).post("/migrate/csv").send({ csv: FILE });
    expect(r.status).toBe(200);
    expect(r.body.rowsUsable).toBe(2);
    expect(draftCount()).toBe(0);
  });

  it("defaults to preview when no step is sent, and refuses an unknown step", async () => {
    expect((await upload(FILE, { step: "preview" })).status).toBe(200);
    const bad = await upload(FILE, { step: "publish" });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe("invalid_request");
  });

  it("returns headers and sample rows when no text column can be found", async () => {
    const r = await upload("Foo,Bar\n1,2\n3,4\n5,6\n7,8\n");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ needsMapping: true, headers: ["Foo", "Bar"], sampleRows: [["1", "2"], ["3", "4"], ["5", "6"]], rowsUsable: 0 });
  });

  it("flags ambiguous slash dates", async () => {
    const r = await upload("Text,Posting Time\nA,01/02/2099 09:00\n");
    expect(r.body.dateOrder).toBe("ambiguous");
  });

  it("reads times in the timezone sent and says so", async () => {
    const r = await upload("Text,Posting Time\nA,2099-05-17 01:00\n", { timezone: "Africa/Johannesburg" });
    expect(r.body.timezone).toBe("Africa/Johannesburg");
    expect(r.body.rows[0].plannedTime).toBe("2099-05-16T23:00:00.000Z");
    const bad = await upload(FILE, { timezone: "Mars/Base" });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe("invalid_timezone");
  });
});

describe("step 2: confirm", () => {
  const fingerprint = async (csv = FILE) => (await upload(csv)).body.fileFingerprint as string;

  it("creates unscheduled drafts for the caller only", async () => {
    const fp = await fingerprint();
    const r = await upload(FILE, { step: "confirm", fileFingerprint: fp });
    expect(r.status).toBe(201);
    expect(r.body.created).toBe(2);
    expect(r.body.draftIds).toHaveLength(2);
    expect(r.body.skipped).toEqual([]);
    expect(r.body.remaining).toBe(0);
    expect(tables.scheduled_posts).toHaveLength(2);
    for (const row of tables.scheduled_posts) {
      expect(row).toMatchObject({ account_id: auth.accountId, status: "draft", scheduled_for: null, social_account_id: null });
      expect((row.tags as string[])[0]).toBe("import:buffer");
    }
    expect(tables.scheduled_posts[0]).toMatchObject({ content: "First post\n\nhttps://example.com/1", planned_date: "2099-05-17" });
  });

  it("answers 409 file_changed when the fingerprint is wrong or missing, and creates nothing", async () => {
    for (const fields of [{ fileFingerprint: "0".repeat(64) }, {}]) {
      const r = await upload(FILE, { step: "confirm", ...fields });
      expect(r.status).toBe(409);
      expect(r.body.code).toBe("file_changed");
    }
    expect(draftCount()).toBe(0);
  });

  it("is idempotent: confirming again creates nothing and says the rows were already imported", async () => {
    const fp = await fingerprint();
    await upload(FILE, { step: "confirm", fileFingerprint: fp });
    const again = await upload(FILE, { step: "confirm", fileFingerprint: fp });
    expect(again.status).toBe(200);
    expect(again.body.created).toBe(0);
    expect(again.body.skipped.map((s: any) => s.reason)).toEqual(["already_imported", "already_imported"]);
    expect(draftCount()).toBe(2);
  });

  it("requires a date order for ambiguous dates (400 date_order_required) and then accepts one", async () => {
    const file = "Text,Posting Time\nA,01/02/2099 09:00\nB,03/04/2099 09:00\n";
    const fp = await fingerprint(file);
    const refused = await upload(file, { step: "confirm", fileFingerprint: fp });
    expect(refused.status).toBe(400);
    expect(refused.body.code).toBe("date_order_required");
    expect(draftCount()).toBe(0);
    const ok = await upload(file, { step: "confirm", fileFingerprint: fp, dateOrder: "dmy" });
    expect(ok.status).toBe(201);
    expect(tables.scheduled_posts[0].planned_date).toBe("2099-02-01");
  });

  it("requires a mapping when no text column exists, validates it, and then imports", async () => {
    const file = "Foo,Bar\nhello there,https://example.com/x\n";
    const fp = await fingerprint(file);
    const needs = await upload(file, { step: "confirm", fileFingerprint: fp });
    expect(needs.status).toBe(400);
    expect(needs.body.code).toBe("mapping_required");
    expect(needs.body.headers).toEqual(["Foo", "Bar"]);
    const bad = await upload(file, { step: "confirm", fileFingerprint: fp, mapping: JSON.stringify({ text: "Nope" }) });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe("invalid_mapping");
    const notJson = await upload(file, { step: "confirm", fileFingerprint: fp, mapping: "{oops" });
    expect(notJson.status).toBe(400);
    expect(draftCount()).toBe(0);
    const ok = await upload(file, { step: "confirm", fileFingerprint: fp, mapping: JSON.stringify({ text: "Foo", link: "Bar" }) });
    expect(ok.status).toBe(201);
    expect(tables.scheduled_posts[0].content).toBe("hello there\n\nhttps://example.com/x");
  });

  it("accepts the JSON form with a mapping object", async () => {
    const file = "Foo\nhello\n";
    const fp = await fingerprint(file);
    const r = await request(app()).post("/migrate/csv").send({ csv: file, step: "confirm", fileFingerprint: fp, mapping: { text: "Foo" } });
    expect(r.status).toBe(201);
  });

  it("lists rows a draft cannot hold as too_long and keeps formula text as plain text", async () => {
    const file = `Text\n${"x".repeat(5001)}\n=1+1\n`;
    const fp = await fingerprint(file);
    const r = await upload(file, { step: "confirm", fileFingerprint: fp });
    expect(r.body.created).toBe(1);
    expect(r.body.skipped).toEqual([{ row: 2, reason: "too_long" }]);
    expect(tables.scheduled_posts[0].content).toBe("=1+1");
  });

  it("surfaces a database failure as a generic 500 without the row text", async () => {
    const fp = await fingerprint();
    vi.spyOn(console, "error").mockImplementation(() => {});
    tables.scheduled_posts = new Proxy([], { get: () => { throw new Error("db down"); } }) as any;
    const r = await upload(FILE, { step: "confirm", fileFingerprint: fp });
    expect(r.status).toBe(500);
    expect(JSON.stringify(r.body)).not.toMatch(/First post/);
  });
});

describe("size and shape limits", () => {
  it("refuses a body over 2 MB with 413, as a file and as JSON", async () => {
    const big = Buffer.alloc(2 * 1024 * 1024 + 10, 0x61);
    const file = await upload(big);
    expect(file.status).toBe(413);
    expect(file.body.code).toBe("file_too_large");
    const json = await request(app()).post("/migrate/csv").send({ csv: "a".repeat(2 * 1024 * 1024 + 10) });
    expect(json.status).toBe(413);
    expect(json.body.code).toBe("file_too_large");
  });

  it("refuses more than 500 data rows, 50 columns and a 20,000 character cell", async () => {
    const rows = "Text\n" + Array.from({ length: 501 }, (_, i) => `r${i}`).join("\n");
    expect((await upload(rows)).body.code).toBe("too_many_rows");
    const cols = Array.from({ length: 51 }, (_, i) => `c${i}`).join(",") + "\n1";
    expect((await upload(cols)).body.code).toBe("too_many_columns");
    const cell = (await upload(`Text\n${"x".repeat(20_001)}`));
    expect(cell.status).toBe(400);
    expect(cell.body.code).toBe("cell_too_long");
  });

  it("answers UTF-16 with 415 and a save-as-UTF-8 hint", async () => {
    const r = await upload(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("Text\nhi", "utf16le")]));
    expect(r.status).toBe(415);
    expect(r.body.error).toMatch(/UTF-8/);
  });

  it("answers empty, header-only, zip and binary uploads with a friendly 400", async () => {
    expect((await upload(Buffer.alloc(0))).body.code).toBe("empty_file");
    expect((await upload("Text,Link\n")).body.code).toBe("header_only");
    const zip = await upload(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00]));
    expect([zip.status, zip.body.code]).toEqual([400, "not_text"]);
    expect((await upload(Buffer.from([0x00, 0x01, 0x02, 0x03]))).body.code).toBe("not_text");
  });

  it("answers a request with no file at all with 400", async () => {
    const r = await request(app()).post("/migrate/csv").send({});
    expect(r.status).toBe(400);
    expect(r.body.code).toBe("no_file");
  });
});

describe("rate limits (stricter than normal routes)", () => {
  it("allows 10 previews an hour, then 429, per signed-in user", async () => {
    for (let i = 0; i < 10; i++) expect((await upload(FILE)).status).toBe(200);
    const blocked = await upload(FILE);
    expect(blocked.status).toBe(429);
    auth.accountId = "someone-else";
    expect((await upload(FILE)).status).toBe(200);
  });

  it("allows 5 confirms an hour, then 429, and previews do not use up confirms", async () => {
    const fp = (await upload(FILE)).body.fileFingerprint;
    for (let i = 0; i < 5; i++) expect((await upload(FILE, { step: "confirm", fileFingerprint: fp })).status).toBeLessThan(300);
    expect((await upload(FILE, { step: "confirm", fileFingerprint: fp })).status).toBe(429);
    expect((await upload(FILE)).status).toBe(200);
  });
});

describe("privacy", () => {
  it("never writes cell contents to the logs", async () => {
    const SECRET = "ZEBRA-SECRET-TEXT-42";
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    const file = `Text,Link,Posting Time\n${SECRET},https://example.com/${SECRET},2099-05-17 14:30\n`;
    const fp = (await upload(file)).body.fileFingerprint;
    await upload(file, { step: "confirm", fileFingerprint: fp });
    await upload(`Text\n"${SECRET}`);
    await upload(file, { step: "confirm", fileFingerprint: "bad" });
    const logged = JSON.stringify(spies.flatMap((s) => s.mock.calls));
    expect(logged).not.toContain(SECRET);
  });
});
