import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FakeApi, KEY, parseMultipart, type Recorded } from "./fakeApi.js";

// These tests run the BUILT CLI (dist/cli.js, made by `npm run build`, which `npm test` runs first)
// as a real child process against a real local HTTP server.
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
      const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
      resolve({ code, stdout, stderr });
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
  dir = mkdtempSync(join(tmpdir(), "lzr-cli-"));
});
afterAll(async () => {
  rmSync(dir, { recursive: true, force: true });
  await api.stop();
});
beforeEach(() => api.reset());

const POST_ROW = { id: "p1", status: "pending", scheduled_for: "2026-10-01T09:00:00.000Z", content: "Hello", social_account_id: "a1" };
const ACCOUNTS = [
  { id: "a1", platform: "instagram", display_name: "Acme IG", brand_label: "Acme", needs_reconnect_at: null },
  { id: "a2", platform: "instagram", display_name: "Acme IG 2", brand_label: null, needs_reconnect_at: "2026-09-01T00:00:00Z" },
  { id: "a3", platform: "tiktok", display_name: "Acme TT", brand_label: null },
];

describe("help and unknown commands", () => {
  it("prints help and exits 0 with no arguments, help, --help and -h", async () => {
    for (const args of [[], ["help"], ["--help"], ["-h"]]) {
      const r = await run(args);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("Usage:");
      expect(r.stdout).toContain("posts schedule");
      expect(r.stderr).toBe("");
    }
    expect(api.requests).toHaveLength(0);
  });

  it("prints per command help for every command with --help and makes no request", async () => {
    const commands = [
      ["whoami"],
      ["accounts"],
      ["rules"],
      ["posts", "list"],
      ["posts", "schedule"],
      ["posts", "now"],
      ["posts", "delete"],
      ["posts", "approve"],
      ["proof"],
      ["media", "upload"],
      ["slots", "next"],
      ["analytics"],
    ];
    for (const cmd of commands) {
      const r = await run([...cmd, "--help"], { LAZYRELAY_API_KEY: undefined });
      expect(r.code, cmd.join(" ")).toBe(0);
      expect(r.stdout, cmd.join(" ")).toContain(`Usage: lazyrelay ${cmd.join(" ")}`);
    }
    expect(api.requests).toHaveLength(0);
  });

  it("supports help <command> and -h", async () => {
    expect((await run(["help", "posts", "schedule"])).stdout).toContain("Usage: lazyrelay posts schedule");
    expect((await run(["help", "analytics"])).stdout).toContain("Usage: lazyrelay analytics");
    expect((await run(["accounts", "-h"])).stdout).toContain("Usage: lazyrelay accounts");
  });

  it("prints help and exits 1 for an unknown command", async () => {
    const r = await run(["frobnicate"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("Unknown command: frobnicate");
    expect(r.stdout).toContain("Usage:");
    expect(api.requests).toHaveLength(0);
  });

  it("shows the group commands for posts, media and slots when the subcommand is missing or unknown", async () => {
    const bare = await run(["posts"]);
    expect(bare.code).toBe(1);
    expect(bare.stdout).toContain("lazyrelay posts schedule");
    const bad = await run(["posts", "bogus"]);
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain("Unknown command: posts bogus");
    const grp = await run(["media", "--help"]);
    expect(grp.code).toBe(0);
    expect(grp.stdout).toContain("lazyrelay media upload");
  });

  it("prints the version", async () => {
    const r = await run(["--version"]);
    expect(r.code).toBe(0);
    const pkg = JSON.parse((await import("node:fs")).readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    expect(r.stdout.trim()).toBe(pkg.version);
  });

  it("never uses em or en dashes in help text", async () => {
    const outputs = [(await run(["help"])).stdout];
    for (const cmd of ["whoami", "accounts", "rules", "posts list", "posts schedule", "posts now", "posts delete", "posts approve", "proof", "media upload", "slots next", "analytics"]) {
      outputs.push((await run([...cmd.split(" "), "--help"])).stdout);
    }
    for (const text of outputs) expect(text).not.toMatch(/[–—]/);
  });
});

describe("credentials", () => {
  it("refuses with exit 1 and no request when there is no key", async () => {
    const r = await run(["accounts"], { LAZYRELAY_API_KEY: undefined });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("No API key");
    expect(r.stdout).toBe("");
    expect(api.requests).toHaveLength(0);
  });

  it("reads the key from LAZYRELAY_API_KEY", async () => {
    api.replyWith({ body: [] });
    await run(["accounts"]);
    expect(only().headers.authorization).toBe(`Bearer ${KEY}`);
  });

  it("lets --key win over the environment", async () => {
    api.replyWith({ body: [] });
    await run(["accounts", "--key", "lzr_live_FROMFLAG"]);
    expect(only().headers.authorization).toBe("Bearer lzr_live_FROMFLAG");
  });

  it("supports --key=value and --base-url", async () => {
    api.replyWith({ body: [] });
    const r = await run(["accounts", "--key=lzr_live_EQ", "--base-url", api.baseUrl], { LAZYRELAY_BASE_URL: "http://127.0.0.1:1/api" });
    expect(r.code).toBe(0);
    expect(only().headers.authorization).toBe("Bearer lzr_live_EQ");
  });

  it("falls back to LAZYRELAY_API_BASE for the address, like the MCP server", async () => {
    api.replyWith({ body: [] });
    const r = await run(["accounts"], { LAZYRELAY_BASE_URL: undefined, LAZYRELAY_API_BASE: api.baseUrl });
    expect(r.code).toBe(0);
    expect(api.requests).toHaveLength(1);
  });

  it("never prints the key, on success, failure or --json", async () => {
    const outputs: Run[] = [];
    api.replyWith({ body: ACCOUNTS });
    outputs.push(await run(["accounts"]), await run(["accounts", "--json"]), await run(["whoami"]), await run(["--help"]));
    api.replyWith({ status: 401, body: { error: "Invalid API key" } });
    outputs.push(await run(["accounts"]), await run(["accounts", "--json"]));
    outputs.push(await run(["accounts", "--key", KEY, "--base-url", "http://127.0.0.1:1/api"]));
    outputs.push(await run(["posts", "schedule", "--key", KEY, "--account", "a1"]));
    for (const r of outputs) {
      expect(r.stdout + r.stderr).not.toContain(KEY);
      expect(r.stdout + r.stderr).not.toContain("lzr_live_");
    }
  });

  it("scrubs the key even if the server echoes it back in an error", async () => {
    api.replyWith({ status: 400, body: { error: `bad token ${KEY}` } });
    const r = await run(["accounts"]);
    expect(r.code).toBe(1);
    expect(r.stderr).not.toContain(KEY);
    expect(r.stderr).toContain("[api key]");
  });
});

describe("whoami and accounts", () => {
  it("whoami counts accounts and lists platforms", async () => {
    api.replyWith({ body: ACCOUNTS });
    const r = await run(["whoami"]);
    expect(r.code).toBe(0);
    const req = only();
    expect(req.method).toBe("GET");
    expect(req.path).toBe("/api/social-accounts");
    expect(r.stdout).toContain("3 connected accounts");
    expect(r.stdout).toContain("instagram (2)");
    expect(r.stdout).toContain("tiktok (1)");
    expect(r.stdout).toContain("1 needs reconnecting");
  });

  it("whoami --json", async () => {
    api.replyWith({ body: ACCOUNTS });
    expect(json(await run(["whoami", "--json"]))).toEqual({ accounts: 3, platforms: { instagram: 2, tiktok: 1 }, needsReconnect: 1 });
  });

  it("whoami with no accounts says so", async () => {
    api.replyWith({ body: [] });
    const r = await run(["whoami"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("No accounts are connected");
  });

  it("accounts prints a table", async () => {
    api.replyWith({ body: ACCOUNTS });
    const r = await run(["accounts"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("ID");
    expect(r.stdout).toContain("PLATFORM");
    expect(r.stdout).toMatch(/a1\s+instagram\s+Acme IG\s+Acme\s+ok/);
    expect(r.stdout).toMatch(/a2\s+instagram\s+Acme IG 2\s+-\s+needs reconnect/);
  });

  it("accounts --json prints the raw response", async () => {
    api.replyWith({ body: ACCOUNTS });
    expect(json(await run(["accounts", "--json"]))).toEqual(ACCOUNTS);
  });

  it("rejects unexpected arguments before any request", async () => {
    const r = await run(["accounts", "extra"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("Unexpected argument: extra");
    expect(api.requests).toHaveLength(0);
  });

  it("rejects an unknown option before any request", async () => {
    const r = await run(["accounts", "--bogus"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("Unknown option --bogus");
    expect(api.requests).toHaveLength(0);
  });
});

describe("rules", () => {
  const rule = {
    platform: "tiktok",
    label: "TikTok",
    text: { maxLength: 2200, note: "Caption." },
    media: { textOnlyAllowed: false, image: { supported: false, formats: [], maxSizeMb: null }, video: { supported: true, formats: ["mp4"], maxSizeMb: 500, maxDurationSec: 600 }, multiItem: null, notes: "" },
    required: ["socialAccountId", "content", "scheduledFor", "tiktokPrivacyLevel"],
    features: ["first comment"],
    options: ["tiktok: aiGenerated flag"],
    limits: { rollingPostsPer24h: null, note: "No cap." },
    lookups: [],
    notes: ["A note."],
    sources: [],
  };

  it("all platforms as a table", async () => {
    api.replyWith({ body: { platforms: [rule] } });
    const r = await run(["rules"]);
    expect(r.code).toBe(0);
    expect(only().path).toBe("/api/platforms/rules");
    expect(only().query).toEqual({});
    expect(r.stdout).toMatch(/tiktok\s+2200\s+no\s+yes\s+socialAccountId, content, scheduledFor, tiktokPrivacyLevel/);
  });

  it("one platform in detail", async () => {
    api.replyWith({ body: { platforms: [rule] } });
    const r = await run(["rules", "tiktok"]);
    expect(only().query).toEqual({ platform: "tiktok" });
    expect(r.stdout).toContain("TikTok (tiktok)");
    expect(r.stdout).toContain("Required: socialAccountId, content, scheduledFor, tiktokPrivacyLevel");
    expect(r.stdout).toContain("Video: mp4, up to 500 MB, up to 600 s");
    expect(r.stdout).toContain("Option tiktok: aiGenerated flag");
  });

  it("--json prints the raw response and an unknown platform fails with the API message", async () => {
    api.replyWith({ body: { platforms: [rule] } });
    expect(json(await run(["rules", "tiktok", "--json"]))).toEqual({ platforms: [rule] });
    api.reset(() => ({ status: 404, body: { error: 'Unknown platform "myspace". Known platforms: tiktok.' } }));
    const r = await run(["rules", "myspace"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('Unknown platform "myspace"');
  });
});

describe("posts list", () => {
  const rows = [
    { ...POST_ROW, id: "p1", status: "pending", content: "First post about spring\nwith a newline", post_results: [] },
    { ...POST_ROW, id: "p2", status: "posted", social_account_id: "a2", content: "Second", post_results: [{ verified_live: true }] },
    { ...POST_ROW, id: "p3", status: "posted", social_account_id: "a1", content: "Third", post_results: [{ verified_live: false }] },
  ];

  it("lists posts as a table", async () => {
    api.replyWith({ body: rows });
    const r = await run(["posts", "list"]);
    expect(r.code).toBe(0);
    expect(only().method).toBe("GET");
    expect(only().path).toBe("/api/scheduled-posts");
    expect(r.stdout).toMatch(/p1\s+pending\s+2026-10-01T09:00:00Z\s+a1\s+-\s+First post about spring with a newline/);
    expect(r.stdout).toMatch(/p2\s+posted\s+.*\s+a2\s+yes\s+Second/);
    expect(r.stdout).toMatch(/p3\s+posted\s+.*\s+a1\s+no\s+Third/);
  });

  it("filters by --status, --account and --limit", async () => {
    api.replyWith({ body: rows });
    expect((json(await run(["posts", "list", "--status", "posted", "--json"])) as unknown[]).length).toBe(2);
    expect((json(await run(["posts", "list", "--account", "a1", "--json"])) as Array<{ id: string }>).map((p) => p.id)).toEqual(["p1", "p3"]);
    expect((json(await run(["posts", "list", "--status", "posted", "--limit", "1", "--json"])) as Array<{ id: string }>).map((p) => p.id)).toEqual(["p2"]);
  });

  it("says so when nothing matches", async () => {
    api.replyWith({ body: [] });
    expect((await run(["posts", "list"])).stdout).toContain("No posts found.");
  });

  it("rejects a bad --status or --limit before any request", async () => {
    const a = await run(["posts", "list", "--status", "sent"]);
    expect(a.code).toBe(1);
    expect(a.stderr).toContain("--status must be one of");
    const b = await run(["posts", "list", "--limit", "many"]);
    expect(b.code).toBe(1);
    expect(b.stderr).toContain("--limit must be a whole number");
    const c = await run(["posts", "list", "--limit", "0"]);
    expect(c.code).toBe(1);
    expect(api.requests).toHaveLength(0);
  });
});

describe("posts schedule", () => {
  const AT = "2026-10-01T09:00:00Z";

  it("sends the right request and prints a line", async () => {
    api.replyWith({ status: 201, body: POST_ROW });
    const r = await run(["posts", "schedule", "--account", "a1", "--text", "Hello there", "--at", AT]);
    expect(r.code).toBe(0);
    const req = only();
    expect(req.method).toBe("POST");
    expect(req.path).toBe("/api/scheduled-posts");
    expect(req.headers["content-type"]).toBe("application/json");
    expect(req.json).toEqual({ socialAccountId: "a1", content: "Hello there", scheduledFor: "2026-10-01T09:00:00.000Z" });
    expect(r.stdout).toContain("Scheduled post p1 for 2026-10-01T09:00:00Z (status: pending).");
  });

  it("maps every flag to its post field", async () => {
    api.replyWith({ status: 201, body: POST_ROW });
    const r = await run([
      "posts", "schedule", "--account", "a1", "--text", "Pin it", "--at", AT,
      "--media", "https://cdn.test/a.png", "--tag", "spring, launch,", "--privacy", "self_only",
      "--board", "board9", "--link", "https://shop.test/x", "--options", '{"tiktok":{"aiGenerated":true}}', "--approval",
    ]);
    expect(r.code).toBe(0);
    expect(only().json).toEqual({
      socialAccountId: "a1",
      content: "Pin it",
      scheduledFor: "2026-10-01T09:00:00.000Z",
      mediaUrl: "https://cdn.test/a.png",
      tags: ["spring", "launch"],
      tiktokPrivacyLevel: "SELF_ONLY",
      boardId: "board9",
      destinationLink: "https://shop.test/x",
      options: { tiktok: { aiGenerated: true } },
      requiresApproval: true,
    });
  });

  it("uses the first --media as mediaUrl and the rest as mediaUrls", async () => {
    api.replyWith({ status: 201, body: POST_ROW });
    await run(["posts", "schedule", "--account", "a1", "--text", "Carousel", "--at", AT, "--media", "https://x.test/1.png", "--media=https://x.test/2.png", "--media", "https://x.test/3.png"]);
    expect(only().json).toMatchObject({ mediaUrl: "https://x.test/1.png", mediaUrls: ["https://x.test/2.png", "https://x.test/3.png"] });
  });

  it("uploads a local file first and posts with the returned URL", async () => {
    const file = join(dir, "pic.png");
    writeFileSync(file, PNG);
    api.reset((req) => (req.path === "/api/media/upload" ? { status: 201, body: { id: "m1", url: "https://cdn.test/uploaded.png", altText: null } } : { status: 201, body: POST_ROW }));
    const r = await run(["posts", "schedule", "--account", "a1", "--text", "With a file", "--at", AT, "--media", file]);
    expect(r.code).toBe(0);
    expect(api.requests.map((q) => `${q.method} ${q.path}`)).toEqual(["POST /api/media/upload", "POST /api/scheduled-posts"]);
    const parts = parseMultipart(api.requests[0]);
    expect(parts[0]).toMatchObject({ name: "file", filename: "pic.png" });
    expect(Buffer.from(parts[0].data, "latin1").equals(PNG)).toBe(true);
    expect(api.requests[0].headers.authorization).toBe(`Bearer ${KEY}`);
    expect(api.requests[1].json).toMatchObject({ mediaUrl: "https://cdn.test/uploaded.png" });
    expect(r.stdout).toContain("Uploaded");
    expect(r.stdout).toContain("Scheduled post p1");
  });

  it("mixes a local file and a URL and keeps --json output clean", async () => {
    const file = join(dir, "pic2.png");
    writeFileSync(file, PNG);
    api.reset((req) => (req.path === "/api/media/upload" ? { status: 201, body: { id: "m2", url: "https://cdn.test/two.png", altText: null } } : { status: 201, body: POST_ROW }));
    const r = await run(["posts", "schedule", "--account", "a1", "--text", "Mix", "--at", AT, "--media", "https://x.test/1.png", "--media", file, "--json"]);
    expect(r.code).toBe(0);
    expect(json(r)).toEqual(POST_ROW);
    expect(api.last.json).toMatchObject({ mediaUrl: "https://x.test/1.png", mediaUrls: ["https://cdn.test/two.png"] });
  });

  it("refuses a missing --account, --text or --at before any network call", async () => {
    const cases: Array<[string[], string]> = [
      [["--text", "x", "--at", AT], "--account"],
      [["--account", "a1", "--at", AT], "--text"],
      [["--account", "a1", "--text", "x"], "--at"],
      [[], "--account, --text, --at"],
    ];
    for (const [flags, missing] of cases) {
      const r = await run(["posts", "schedule", ...flags]);
      expect(r.code, flags.join(" ")).toBe(1);
      expect(r.stderr).toContain(`Missing ${missing}`);
      expect(r.stdout).toBe("");
    }
    // Refuses even when the key is also missing: the flags are checked first.
    const noKey = await run(["posts", "schedule", "--text", "x"], { LAZYRELAY_API_KEY: undefined });
    expect(noKey.stderr).toContain("Missing --account, --at");
    expect(api.requests).toHaveLength(0);
  });

  it("refuses blank values, a bad --at, bad --options and a missing media file before any request", async () => {
    const base = ["posts", "schedule", "--account", "a1", "--text", "x", "--at", AT];
    const blank = await run(["posts", "schedule", "--account", "  ", "--text", "x", "--at", AT]);
    expect(blank.stderr).toContain("Missing --account");
    const badAt = await run(["posts", "schedule", "--account", "a1", "--text", "x", "--at", "next tuesday-ish"]);
    expect(badAt.code).toBe(1);
    expect(badAt.stderr).toContain("--at must be an ISO 8601 time");
    const badJson = await run([...base, "--options", "{nope"]);
    expect(badJson.code).toBe(1);
    expect(badJson.stderr).toContain("--options must be valid JSON");
    const notObject = await run([...base, "--options", "[1,2]"]);
    expect(notObject.stderr).toContain("--options must be a JSON object");
    const noFile = await run([...base, "--media", join(dir, "missing.png")]);
    expect(noFile.code).toBe(1);
    expect(noFile.stderr).toContain("Media file not found");
    const emptyTag = await run([...base, "--tag", " , "]);
    expect(emptyTag.stderr).toContain("--tag needs at least one label");
    const noValue = await run([...base, "--board"]);
    expect(noValue.stderr).toContain("--board needs a value");
    expect(api.requests).toHaveLength(0);
  });

  it("does not treat the next flag as a value", async () => {
    const r = await run(["posts", "schedule", "--account", "--text", "x", "--at", AT]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("--account needs a value");
    expect(api.requests).toHaveLength(0);
  });

  it("allows text that starts with a dash", async () => {
    api.replyWith({ status: 201, body: POST_ROW });
    const r = await run(["posts", "schedule", "--account", "a1", "--text", "-5 degrees today", "--at", AT]);
    expect(r.code).toBe(0);
    expect(only().json).toMatchObject({ content: "-5 degrees today" });
  });

  it("prints the API message and hint on stderr and exits 1 when the API refuses", async () => {
    api.replyWith({ status: 403, body: { error: "Free tier limit reached: 10 posts per connected account per month. Upgrade to Starter for unlimited posts, or wait until next month." } });
    const r = await run(["posts", "schedule", "--account", "a1", "--text", "x", "--at", AT]);
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("Error: Free tier limit reached");
    expect(r.stderr).toContain("Hint: This is a plan limit");
    expect(api.requests).toHaveLength(1);
  });

  it("does not retry a failed schedule (a retry could post twice)", async () => {
    api.replyWith({ status: 503, body: { error: "Unavailable" }, headers: { "Retry-After": "0" } });
    const r = await run(["posts", "schedule", "--account", "a1", "--text", "x", "--at", AT]);
    expect(r.code).toBe(1);
    expect(api.requests).toHaveLength(1);
  });
});

describe("posts now", () => {
  it("publishes right away with scheduledFor set to the current time", async () => {
    api.replyWith({ status: 201, body: POST_ROW });
    const before = Date.now();
    const r = await run(["posts", "now", "--account", "a1", "--text", "Live now", "--tag", "x"]);
    expect(r.code).toBe(0);
    const req = only();
    expect(req.method).toBe("POST");
    expect(req.path).toBe("/api/scheduled-posts");
    const body = req.json as Record<string, unknown>;
    expect(body).toMatchObject({ socialAccountId: "a1", content: "Live now", tags: ["x"] });
    expect(Math.abs(new Date(body.scheduledFor as string).getTime() - before)).toBeLessThan(15000);
    expect(r.stdout).toContain("Queued post p1");
    expect(r.stdout).toContain("not live yet");
  });

  it("refuses missing --account or --text but does not need --at", async () => {
    const r = await run(["posts", "now", "--account", "a1"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("Missing --text");
    const atNotAllowed = await run(["posts", "now", "--account", "a1", "--text", "x", "--at", "2026-10-01T09:00:00Z"]);
    expect(atNotAllowed.code).toBe(1);
    expect(atNotAllowed.stderr).toContain("Unknown option --at");
    expect(api.requests).toHaveLength(0);
  });

  it("uploads a local --media file first", async () => {
    const file = join(dir, "now.png");
    writeFileSync(file, PNG);
    api.reset((req) => (req.path === "/api/media/upload" ? { status: 201, body: { id: "m3", url: "https://cdn.test/now.png", altText: null } } : { status: 201, body: POST_ROW }));
    const r = await run(["posts", "now", "--account", "a1", "--text", "x", "--media", file, "--json"]);
    expect(r.code).toBe(0);
    expect(api.requests.map((q) => q.path)).toEqual(["/api/media/upload", "/api/scheduled-posts"]);
    expect(api.last.json).toMatchObject({ mediaUrl: "https://cdn.test/now.png" });
  });
});

describe("posts delete and approve, proof, slots, media, analytics", () => {
  it("posts delete handles the 204 answer", async () => {
    api.replyWith({ status: 204 });
    const r = await run(["posts", "delete", "p1"]);
    expect(r.code).toBe(0);
    expect(only().method).toBe("DELETE");
    expect(only().path).toBe("/api/scheduled-posts/p1");
    expect(r.stdout).toContain("Deleted post p1.");
    api.reset(() => ({ status: 204 }));
    expect(json(await run(["posts", "delete", "p1", "--json"]))).toEqual({ deleted: true, id: "p1" });
  });

  it("posts delete with a 404 exits 1 with the API message", async () => {
    api.replyWith({ status: 404, body: { error: "Not found or not owned by this caller" } });
    const r = await run(["posts", "delete", "nope"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("Error: Not found or not owned by this caller");
    expect(r.stderr).toContain("Hint:");
  });

  it("posts delete and approve require an id", async () => {
    for (const sub of ["delete", "approve"]) {
      const r = await run(["posts", sub]);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("Missing <id>");
    }
    expect(api.requests).toHaveLength(0);
  });

  it("posts approve", async () => {
    api.replyWith({ body: { ...POST_ROW, status: "pending" } });
    const r = await run(["posts", "approve", "p1"]);
    expect(r.code).toBe(0);
    expect(only().method).toBe("PATCH");
    expect(only().path).toBe("/api/scheduled-posts/p1/approve");
    expect(r.stdout).toContain("Approved post p1 (status: pending).");
  });

  it("proof prints the link, and --json the object", async () => {
    api.replyWith({ body: { url: "https://lazyrelay.com/verify/r1" } });
    const r = await run(["proof", "p1"]);
    expect(only().path).toBe("/api/scheduled-posts/p1/proof-link");
    expect(r.stdout.trim()).toBe("https://lazyrelay.com/verify/r1");
    expect(json(await run(["proof", "p1", "--json"]))).toEqual({ url: "https://lazyrelay.com/verify/r1" });
  });

  it("proof reports a 403 for a key that may not share proof", async () => {
    api.replyWith({ status: 403, body: { error: "This API key isn't permitted to generate proof-sharing links. Enable it for this key in your dashboard's API Keys settings." } });
    const r = await run(["proof", "p1"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("isn't permitted to generate proof-sharing links");
  });

  it("slots next", async () => {
    api.replyWith({ body: { scheduledFor: "2026-10-03T07:00:00.000Z" } });
    const r = await run(["slots", "next", "a1"]);
    expect(only().path).toBe("/api/posting-slots/next");
    expect(only().query).toEqual({ socialAccountId: "a1" });
    expect(r.stdout.trim()).toBe("2026-10-03T07:00:00.000Z");
    expect(json(await run(["slots", "next", "a1", "--json"]))).toEqual({ scheduledFor: "2026-10-03T07:00:00.000Z" });
  });

  it("slots next with no saved times fails with the API message", async () => {
    api.replyWith({ status: 404, body: { error: "No posting times saved yet. Add some in Settings, then try again." } });
    const r = await run(["slots", "next", "a1"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("No posting times saved yet");
  });

  it("media upload sends the file and prints the URL", async () => {
    const file = join(dir, "up.png");
    writeFileSync(file, PNG);
    api.replyWith({ status: 201, body: { id: "m9", url: "https://cdn.test/up.png", altText: "A square" } });
    const r = await run(["media", "upload", file, "--alt", "A square"]);
    expect(r.code).toBe(0);
    const req = only();
    expect(req.method).toBe("POST");
    expect(req.path).toBe("/api/media/upload");
    const parts = parseMultipart(req);
    expect(parts.map((p) => p.name)).toEqual(["file", "altText"]);
    expect(parts[1].data).toBe("A square");
    expect(r.stdout).toContain("Uploaded: https://cdn.test/up.png");
    expect(r.stdout).toContain("Media id: m9");
    api.reset(() => ({ status: 201, body: { id: "m9", url: "https://cdn.test/up.png", altText: null } }));
    expect(json(await run(["media", "upload", file, "--json"]))).toEqual({ id: "m9", url: "https://cdn.test/up.png", altText: null });
  });

  it("media upload refuses a missing file and a missing argument before any request", async () => {
    const a = await run(["media", "upload", join(dir, "ghost.png")]);
    expect(a.code).toBe(1);
    expect(a.stderr).toContain("File not found");
    const b = await run(["media", "upload"]);
    expect(b.code).toBe(1);
    expect(b.stderr).toContain("Missing <file>");
    expect(api.requests).toHaveLength(0);
  });

  const SUMMARY = {
    rangeDays: 7,
    totalPosts: 12,
    byStatus: { posted: 10, failed: 1, pending: 1 },
    byPlatform: { instagram: { total: 8, posted: 7, failed: 1, verifiedLive: 7 } },
    dailyCounts: {},
    verifiedLiveRate: 0.875,
    engagement: { instagram: { likes: 40, comments: 5, shares: 2, views: 900, postsWithData: 6 } },
    availableTags: ["spring", "launch"],
  };

  it("analytics sends the filters and prints a summary", async () => {
    api.replyWith({ body: SUMMARY });
    const r = await run(["analytics", "--days", "7", "--tag", "spring", "--brand", "Acme"]);
    expect(r.code).toBe(0);
    expect(only().path).toBe("/api/analytics/summary");
    expect(only().query).toEqual({ days: "7", tag: "spring", brand: "Acme" });
    expect(r.stdout).toContain("Last 7 days: 12 posts, verified live rate 88%");
    expect(r.stdout).toContain("Status: posted 10, failed 1, pending 1");
    expect(r.stdout).toMatch(/instagram\s+8\s+7\s+1\s+7/);
    expect(r.stdout).toMatch(/instagram\s+40\s+5\s+2\s+900/);
    expect(r.stdout).toContain("Tags in use: spring, launch");
  });

  it("analytics with no options and --json", async () => {
    api.replyWith({ body: SUMMARY });
    expect(json(await run(["analytics", "--json"]))).toEqual(SUMMARY);
    expect(only().query).toEqual({});
  });

  it("analytics rejects a bad --days before any request", async () => {
    expect((await run(["analytics", "--days", "abc"])).code).toBe(1);
    const tooMany = await run(["analytics", "--days", "365"]);
    expect(tooMany.code).toBe(1);
    expect(tooMany.stderr).toContain("at most 90");
    expect(api.requests).toHaveLength(0);
  });
});

describe("failures", () => {
  it("exits 1 with a plain message when the API cannot be reached", async () => {
    const r = await run(["accounts"], { LAZYRELAY_BASE_URL: "http://127.0.0.1:1/api" });
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("Could not reach LazyRelay");
  });

  it("exits 1 on a 401 with the API message", async () => {
    api.replyWith({ status: 401, body: { error: "Invalid API key" } });
    const r = await run(["accounts"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("Error: Invalid API key");
  });

  it("retries a GET once through the CLI on 503 and succeeds", async () => {
    api.reset((_req, n) => (n === 1 ? { status: 503, body: { error: "x" }, headers: { "Retry-After": "0" } } : { status: 200, body: ACCOUNTS }));
    const r = await run(["whoami"]);
    expect(r.code).toBe(0);
    expect(api.requests).toHaveLength(2);
  });

  it("keeps stdout empty on failure even with --json", async () => {
    api.replyWith({ status: 500, body: { error: "Something went wrong on our end. Please try again." } });
    const r = await run(["posts", "list", "--json"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("Something went wrong on our end");
  });
});
