import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FakeApi, KEY, type Recorded } from "./fakeApi.js";

// Second CLI suite: tiktok, boards, review, reschedule/pause/resume/history and hint rewriting.
const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const api = new FakeApi();
let dir: string;
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

function run(args: string[], env: Record<string, string | undefined> = {}): Promise<Run> {
  const base: NodeJS.ProcessEnv = { ...process.env };
  delete base.LAZYRELAY_API_KEY;
  delete base.LAZYRELAY_BASE_URL;
  delete base.LAZYRELAY_API_BASE;
  const merged: NodeJS.ProcessEnv = { ...base, LAZYRELAY_API_KEY: KEY, LAZYRELAY_BASE_URL: api.baseUrl, ...env };
  for (const [k, v] of Object.entries(merged)) if (v === undefined) delete merged[k];
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], { env: merged, timeout: 20000 }, (error, stdout, stderr) => {
      resolve({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, stdout, stderr });
    });
  });
}

const json = (r: Run) => JSON.parse(r.stdout);
const only = (): Recorded => {
  expect(api.requests).toHaveLength(1);
  return api.last;
};

beforeAll(async () => {
  await api.start();
  dir = mkdtempSync(join(tmpdir(), "lzr-cli2-"));
});
afterAll(async () => {
  rmSync(dir, { recursive: true, force: true });
  await api.stop();
});
beforeEach(() => api.reset());

const POST_ROW = { id: "p1", status: "pending", scheduled_for: "2026-10-01T09:00:00.000Z", content: "Hello", social_account_id: "a1" };

describe("tiktok and boards", () => {
  it("tiktok prints the creator info", async () => {
    api.replyWith({ body: { nickname: "acme", canPost: true, cantPostReason: null, maxVideoDurationSec: 600, privacyLevelOptions: ["PUBLIC_TO_EVERYONE", "SELF_ONLY"] } });
    const r = await run(["tiktok", "a3"]);
    expect(r.code).toBe(0);
    expect(only().method).toBe("GET");
    expect(only().path).toBe("/api/social-accounts/a3/tiktok-creator-info");
    expect(r.stdout).toContain("Nickname: acme");
    expect(r.stdout).toContain("Can post now: yes");
    expect(r.stdout).toContain("Longest video: 600 seconds");
    expect(r.stdout).toContain("Privacy levels: PUBLIC_TO_EVERYONE, SELF_ONLY");
  });

  it("tiktok shows why an account cannot post, and --json is raw", async () => {
    const info = { nickname: null, canPost: false, cantPostReason: "Daily limit reached", maxVideoDurationSec: null, privacyLevelOptions: [] };
    api.replyWith({ body: info });
    const r = await run(["tiktok", "a3"]);
    expect(r.stdout).toContain("Can post now: no (Daily limit reached)");
    expect(r.stdout).toContain("Longest video: unknown");
    expect(r.stdout).toContain("Privacy levels: none returned");
    expect(json(await run(["tiktok", "a3", "--json"]))).toEqual(info);
  });

  it("boards prints a table, an empty note, and --json", async () => {
    api.replyWith({ body: [{ id: "b1", name: "Recipes" }] });
    const r = await run(["boards", "a4"]);
    expect(only().path).toBe("/api/social-accounts/a4/boards");
    expect(r.stdout).toMatch(/b1\s+Recipes/);
    expect(json(await run(["boards", "a4", "--json"]))).toEqual([{ id: "b1", name: "Recipes" }]);
    api.replyWith({ body: [] });
    expect((await run(["boards", "a4"])).stdout).toContain("No boards found");
  });

  it("both require an account id before any request", async () => {
    for (const c of ["tiktok", "boards"]) {
      const r = await run([c]);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("Missing <accountId>");
    }
    expect(api.requests).toHaveLength(0);
  });
});

describe("CLI friendly hints", () => {
  const hintFor = async (error: string, status = 400) => {
    api.replyWith({ status, body: { error } });
    const r = await run(["posts", "now", "--account", "a1", "--text", "x"]);
    expect(r.code).toBe(1);
    return r.stderr;
  };

  it("rewrites SDK method names into commands", async () => {
    const tiktok = await hintFor("tiktokPrivacyLevel is required when posting to TikTok");
    expect(tiktok).toContain("Hint: Run: lazyrelay tiktok <accountId>");
    expect(tiktok).toContain("--privacy");
    const boards = await hintFor("Pinterest board is required");
    expect(boards).toContain("Run: lazyrelay boards <accountId>");
    expect(boards).toContain("--board");
    expect(await hintFor("options.tiktok is not used by this platform")).toContain("Run: lazyrelay rules <platform>");
    expect(await hintFor("Pinterest allows 10 posts in 24 hours (rolling window)")).toContain("Run: lazyrelay slots next <accountId>");
    expect(await hintFor("Social account not found or not owned by this caller", 403)).toContain("Run: lazyrelay accounts");
    expect(await hintFor("scheduledFor can't be in the past")).toContain("--at must be an ISO 8601");
  });

  it("no CLI hint mentions an SDK call", async () => {
    const cases: Array<[string, number]> = [
      ["tiktokPrivacyLevel is required", 400],
      ["Pinterest board is required", 400],
      ["options.x is wrong", 400],
      ["daily limit hit", 422],
      ["not owned by this caller", 403],
      ["scheduledFor invalid", 400],
    ];
    for (const [msg, status] of cases) {
      const hint = (await hintFor(msg, status)).split("\n").find((l) => l.startsWith("Hint:")) ?? "";
      expect(hint, msg).not.toBe("");
      expect(hint, msg).not.toMatch(/\w+\.\w+\(/);
    }
  });

  it("leaves the SDK's own hints unchanged", async () => {
    const { describeApiError } = await import("../src/index.js");
    expect(describeApiError(400, "tiktokPrivacyLevel is required").hint).toContain("tiktok.creatorInfo(accountId)");
    expect(describeApiError(403, "not owned").hint).toContain("accounts.list()");
  });

  it("cliHint keeps text it does not know", async () => {
    const { cliHint } = await import("../src/cliCore.js");
    expect(cliHint("Tell the account owner.")).toBe("Tell the account owner.");
  });

  it("413 through the CLI prints the message", async () => {
    api.replyWith({ status: 413, body: { error: "Storage quota reached" } });
    const file = join(dir, "big.png");
    writeFileSync(file, PNG);
    const r = await run(["media", "upload", file]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("Error: Storage quota reached");
  });
});

describe("posts reschedule, pause, resume, history", () => {
  it("reschedule sends the ISO time", async () => {
    api.replyWith({ body: POST_ROW });
    const r = await run(["posts", "reschedule", "p1", "--at", "2026-12-01T10:00:00+02:00"]);
    expect(r.code).toBe(0);
    expect(only().method).toBe("PATCH");
    expect(only().path).toBe("/api/scheduled-posts/p1/reschedule");
    expect(only().json).toEqual({ scheduledFor: "2026-12-01T08:00:00.000Z" });
    expect(r.stdout).toContain("Rescheduled post p1");
    api.reset(() => ({ body: POST_ROW }));
    expect(json(await run(["posts", "reschedule", "p1", "--at", "2026-12-01T10:00:00Z", "--json"]))).toEqual(POST_ROW);
  });

  it("reschedule refuses a missing id, a missing or bad --at before any request", async () => {
    expect((await run(["posts", "reschedule", "--at", "2026-12-01T10:00:00Z"])).stderr).toContain("Missing <id>");
    expect((await run(["posts", "reschedule", "p1"])).stderr).toContain("Missing --at");
    expect((await run(["posts", "reschedule", "p1", "--at", "soon"])).stderr).toContain("--at must be an ISO 8601");
    expect(api.requests).toHaveLength(0);
  });

  it("pause and resume", async () => {
    api.replyWith({ body: POST_ROW });
    const p = await run(["posts", "pause", "p1"]);
    expect(api.last.method).toBe("PATCH");
    expect(api.last.path).toBe("/api/scheduled-posts/p1/pause");
    expect(p.stdout).toContain("Paused post p1.");
    const q = await run(["posts", "resume", "p1"]);
    expect(api.last.path).toBe("/api/scheduled-posts/p1/resume");
    expect(q.stdout).toContain("Resumed post p1.");
    expect(json(await run(["posts", "pause", "p1", "--json"]))).toEqual(POST_ROW);
    expect((await run(["posts", "pause"])).stderr).toContain("Missing <id>");
    expect((await run(["posts", "resume"])).stderr).toContain("Missing <id>");
  });

  it("pause reports a 404 with the API message", async () => {
    api.replyWith({ status: 404, body: { error: "Not found, not owned by this caller, not pending, or already paused" } });
    const r = await run(["posts", "pause", "p1"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("already paused");
  });

  it("history passes --limit and --before and prints a table", async () => {
    api.replyWith({ body: [{ ...POST_ROW, id: "old1", status: "posted", post_results: [{ verified_live: true }] }] });
    const r = await run(["posts", "history", "--limit", "20", "--before", "2026-09-01T00:00:00Z"]);
    expect(r.code).toBe(0);
    expect(only().path).toBe("/api/scheduled-posts/history");
    expect(only().query).toEqual({ limit: "20", before: "2026-09-01T00:00:00Z" });
    expect(r.stdout).toMatch(/old1\s+posted/);
    expect(json(await run(["posts", "history", "--json"]))).toHaveLength(1);
    api.replyWith({ body: [] });
    expect((await run(["posts", "history"])).stdout).toContain("No older posts found.");
  });

  it("history rejects a bad --limit before any request", async () => {
    expect((await run(["posts", "history", "--limit", "x"])).code).toBe(1);
    expect((await run(["posts", "history", "--limit", "101"])).stderr).toContain("at most 100");
    expect(api.requests).toHaveLength(0);
  });
});

describe("review links", () => {
  const LINK = { id: "r1", token: "tok123", label: "Acme", brandLabel: null, expiresAt: "2026-10-30T00:00:00.000Z", lastViewedAt: null, createdAt: "2026-09-30T00:00:00.000Z", status: "active" };

  it("review create sends the options and prints the client URL", async () => {
    api.replyWith({ status: 201, body: LINK });
    const r = await run(["review", "create", "--label", "Acme", "--days", "14", "--brand", "Acme Co"]);
    expect(r.code).toBe(0);
    expect(only().method).toBe("POST");
    expect(only().path).toBe("/api/review-links");
    expect(only().json).toEqual({ label: "Acme", brandLabel: "Acme Co", expiresInDays: 14 });
    expect(r.stdout).toContain("https://lazyrelay.com/review/tok123");
    expect(r.stdout).toContain("expires 2026-10-30T00:00:00Z");
  });

  it("review create with no options and --json includes the url", async () => {
    api.replyWith({ status: 201, body: LINK });
    const r = await run(["review", "create", "--json"]);
    expect(json(r)).toEqual({ ...LINK, url: "https://lazyrelay.com/review/tok123" });
    expect(only().json).toEqual({});
  });

  it("review create surfaces a plan limit", async () => {
    api.replyWith({ status: 403, body: { error: "Client review links are part of the Pro plan and above. Upgrade to send a link to your clients." } });
    const r = await run(["review", "create"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("Pro plan and above");
    expect(r.stderr).toContain("Hint: This is a plan limit");
  });

  it("review create rejects a bad --days before any request", async () => {
    expect((await run(["review", "create", "--days", "0"])).code).toBe(1);
    expect((await run(["review", "create", "--days", "91"])).stderr).toContain("at most 90");
    expect(api.requests).toHaveLength(0);
  });

  it("review list prints a table with the address, and an empty note", async () => {
    api.replyWith({ body: { maxLinks: 3, links: [LINK] } });
    const r = await run(["review", "list"]);
    expect(only().path).toBe("/api/review-links");
    expect(r.stdout).toMatch(/r1\s+Acme\s+active\s+2026-10-30T00:00:00Z\s+https:\/\/lazyrelay\.com\/review\/tok123/);
    expect(json(await run(["review", "list", "--json"]))).toEqual({ maxLinks: 3, links: [LINK] });
    api.replyWith({ body: { maxLinks: 3, links: [] } });
    expect((await run(["review", "list"])).stdout).toContain("No review links yet.");
  });

  it("review revoke", async () => {
    api.replyWith({ body: { revoked: true } });
    const r = await run(["review", "revoke", "r1"]);
    expect(only().method).toBe("DELETE");
    expect(only().path).toBe("/api/review-links/r1");
    expect(r.stdout).toContain("Revoked review link r1.");
    expect(json(await run(["review", "revoke", "r1", "--json"]))).toEqual({ revoked: true });
    expect((await run(["review", "revoke"])).stderr).toContain("Missing <id>");
  });

  it("review revoke reports a 404", async () => {
    api.replyWith({ status: 404, body: { error: "Link not found, or already removed" } });
    const r = await run(["review", "revoke", "zzz"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("Link not found");
  });

  it("the review group shows its commands when the subcommand is missing", async () => {
    const bare = await run(["review"]);
    expect(bare.code).toBe(1);
    expect(bare.stdout).toContain("lazyrelay review create");
    expect((await run(["review", "--help"])).code).toBe(0);
  });
});

describe("help for the new commands", () => {
  it("has per command help and no special dashes", async () => {
    const cmds = [["tiktok"], ["boards"], ["posts", "reschedule"], ["posts", "pause"], ["posts", "resume"], ["posts", "history"], ["review", "create"], ["review", "list"], ["review", "revoke"]];
    for (const cmd of cmds) {
      const r = await run([...cmd, "--help"], { LAZYRELAY_API_KEY: undefined });
      expect(r.code, cmd.join(" ")).toBe(0);
      expect(r.stdout).toContain(`Usage: lazyrelay ${cmd.join(" ")}`);
      expect(r.stdout).not.toMatch(/[–—]/);
    }
    const top = (await run(["help"])).stdout;
    for (const s of ["tiktok <accountId>", "boards <accountId>", "review create", "posts reschedule", "posts history"]) expect(top).toContain(s);
    expect(api.requests).toHaveLength(0);
  });
});
