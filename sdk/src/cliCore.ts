import { statSync } from "node:fs";
import { LazyRelay } from "./index.js";
import { LazyRelayError } from "./errors.js";
import { parseArgs, UsageError, type FlagSpec, type ParsedArgs } from "./args.js";
import { formatTime, shorten, table } from "./format.js";
import { COMMAND_HELP, TOP_HELP } from "./help.js";
import { VERSION } from "./version.js";
import type { PostFields, PostStatus, ScheduledPost, PublishNowInput, SchedulePostInput } from "./types.js";

export interface CliContext {
  env: Record<string, string | undefined>;
  /** Writes to standard output. Called with text that has no trailing newline. */
  out: (text: string) => void;
  /** Writes to standard error. */
  err: (text: string) => void;
  /** Replaces the global fetch (tests). */
  fetch?: typeof fetch;
}

const GROUPS = ["posts", "media", "slots", "review"];

const STATUSES: PostStatus[] = ["draft", "needs_approval", "pending", "posting", "posted", "failed"];

const COMPOSE_SPEC: FlagSpec = {
  value: ["account", "text", "tag", "privacy", "board", "link", "options"],
  repeat: ["media"],
  bool: ["approval"],
};

const SPECS: Record<string, FlagSpec> = {
  whoami: {},
  accounts: {},
  rules: {},
  "posts list": { value: ["status", "account", "limit"] },
  "posts schedule": { ...COMPOSE_SPEC, value: [...(COMPOSE_SPEC.value ?? []), "at"] },
  "posts now": COMPOSE_SPEC,
  "posts delete": {},
  "posts approve": {},
  proof: {},
  "media upload": { value: ["alt"] },
  "slots next": {},
  analytics: { value: ["days", "tag", "brand"] },
  tiktok: {},
  boards: {},
  "posts reschedule": { value: ["at"] },
  "posts pause": {},
  "posts resume": {},
  "posts history": { value: ["limit", "before"] },
  "review create": { value: ["label", "days", "brand"] },
  "review list": {},
  "review revoke": {},
};

/** SDK hints name SDK methods. In the CLI, say the equivalent command instead. */
export function cliHint(hint: string): string {
  return hint
    .replace("Call tiktok.creatorInfo(accountId)", "Run: lazyrelay tiktok <accountId>")
    .replace("then send tiktokPrivacyLevel", "then pass --privacy")
    .replace("Call pinterest.boards(accountId) and send boardId (and destinationLink if the platform needs one)", "Run: lazyrelay boards <accountId>, then pass --board (and --link if the platform needs one)")
    .replace("Call rules.get(platform)", "Run: lazyrelay rules <platform>")
    .replace("Use slots.next(accountId)", "Run: lazyrelay slots next <accountId>")
    .replace("Call accounts.list()", "Run: lazyrelay accounts")
    .replace("scheduledFor must be", "--at must be");
}

/** Runs the CLI and returns the exit code: 0 on success, 1 on any error. Never throws. */
export async function runCli(argv: string[], ctx: CliContext): Promise<number> {
  const line = (s = "") => ctx.out(`${s}\n`);
  const errLine = (s = "") => ctx.err(`${s}\n`);
  let secret = "";
  const scrub = (s: string) => (secret ? s.split(secret).join("[api key]") : s);

  try {
    if (argv.length === 0) {
      ctx.out(TOP_HELP);
      return 0;
    }
    if (argv[0] === "--version" || argv[0] === "-v" || argv[0] === "version") {
      line(VERSION);
      return 0;
    }
    if (argv[0] === "help" || argv[0] === "--help" || argv[0] === "-h") {
      // "lazyrelay help posts schedule" shows that command's help.
      const words = argv.slice(1).filter((t) => !t.startsWith("-"));
      const twoWords = words.slice(0, 2).join(" ");
      if (twoWords in COMMAND_HELP) ctx.out(COMMAND_HELP[twoWords]);
      else if (words[0] in COMMAND_HELP) ctx.out(COMMAND_HELP[words[0]]);
      else if (GROUPS.includes(words[0])) ctx.out(groupHelp(words[0]));
      else ctx.out(TOP_HELP);
      return 0;
    }

    // Work out which command this is: one word, or two for posts / media / slots.
    const first = argv[0];
    const two = GROUPS.includes(first);
    const second = two ? argv[1] : undefined;
    const path = two && second && !second.startsWith("-") ? `${first} ${second}` : first;
    if (two && !(path in SPECS)) {
      // "lazyrelay posts --help" or "lazyrelay posts bogus": show the group's commands.
      const wantsHelp = argv.slice(1).some((t) => t === "--help" || t === "-h");
      if (wantsHelp || !second || second.startsWith("-")) {
        ctx.out(groupHelp(first));
        return wantsHelp ? 0 : 1;
      }
      errLine(`Unknown command: ${first} ${second}`);
      ctx.out(groupHelp(first));
      return 1;
    }
    if (!(path in SPECS)) {
      errLine(`Unknown command: ${first}`);
      ctx.out(TOP_HELP);
      return 1;
    }

    const rest = argv.slice(two ? 2 : 1);
    const parsed = parseArgs(rest, SPECS[path]);
    if (parsed.bools.has("help")) {
      ctx.out(COMMAND_HELP[path]);
      return 0;
    }

    // Everything that can be checked without the network is checked before any request.
    const plan = await prepare(path, parsed);

    const apiKey = (parsed.values.key ?? ctx.env.LAZYRELAY_API_KEY ?? "").trim();
    if (!apiKey) throw new UsageError("No API key. Set LAZYRELAY_API_KEY or pass --key. Create one in the dashboard under Settings, More, API Keys.");
    secret = apiKey;
    const client = new LazyRelay({
      apiKey,
      baseUrl: parsed.values["base-url"] ?? ctx.env.LAZYRELAY_BASE_URL ?? ctx.env.LAZYRELAY_API_BASE,
      fetch: ctx.fetch,
    });
    const json = parsed.bools.has("json");
    const io = { line, json, err: errLine };
    await plan(client, io);
    return 0;
  } catch (err) {
    if (err instanceof UsageError) {
      errLine(scrub(`Error: ${err.message}`));
      return 1;
    }
    if (err instanceof LazyRelayError) {
      errLine(scrub(`Error: ${err.message}`));
      if (err.hint) errLine(scrub(`Hint: ${cliHint(err.hint)}`));
      return 1;
    }
    errLine(scrub(`Error: ${err instanceof Error ? err.message : String(err)}`));
    return 1;
  }
}

function groupHelp(group: string): string {
  const lines = Object.keys(COMMAND_HELP)
    .filter((k) => k.startsWith(`${group} `))
    .map((k) => `  lazyrelay ${k}`);
  return `Usage: lazyrelay ${group} <command>\n\nCommands:\n${lines.join("\n")}\n\nRun lazyrelay ${group} <command> --help for details.\n`;
}

interface Io {
  line: (s?: string) => void;
  err: (s?: string) => void;
  json: boolean;
}

type Plan = (client: LazyRelay, io: Io) => Promise<void>;

const printJson = (io: Io, value: unknown) => io.line(JSON.stringify(value === undefined ? null : value, null, 2));

function needPositional(parsed: ParsedArgs, name: string, path: string): string {
  const [value, ...extra] = parsed.positional;
  if (!value) throw new UsageError(`Missing <${name}>. Usage: see lazyrelay ${path} --help`);
  if (extra.length) throw new UsageError(`Unexpected extra argument: ${extra[0]}`);
  return value;
}

function noPositional(parsed: ParsedArgs) {
  if (parsed.positional.length) throw new UsageError(`Unexpected argument: ${parsed.positional[0]}`);
}

/** Validates arguments (no network) and returns the work to do once the key is known. */
async function prepare(path: string, parsed: ParsedArgs): Promise<Plan> {
  switch (path) {
    case "whoami": {
      noPositional(parsed);
      return async (c, io) => {
        const accounts = await c.accounts.list();
        const platforms: Record<string, number> = {};
        for (const a of accounts) platforms[a.platform] = (platforms[a.platform] ?? 0) + 1;
        const needsReconnect = accounts.filter((a) => a.needs_reconnect_at).length;
        if (io.json) return printJson(io, { accounts: accounts.length, platforms, needsReconnect });
        if (accounts.length === 0) return io.line("API key works. No accounts are connected yet.");
        const names = Object.entries(platforms).map(([p, n]) => `${p} (${n})`).join(", ");
        io.line(`API key works. ${accounts.length} connected account${accounts.length === 1 ? "" : "s"}: ${names}`);
        if (needsReconnect) io.line(`${needsReconnect} need${needsReconnect === 1 ? "s" : ""} reconnecting in the dashboard.`);
      };
    }

    case "accounts": {
      noPositional(parsed);
      return async (c, io) => {
        const accounts = await c.accounts.list();
        if (io.json) return printJson(io, accounts);
        if (accounts.length === 0) return io.line("No accounts are connected yet.");
        io.line(table(["ID", "PLATFORM", "NAME", "BRAND", "STATUS"], accounts.map((a) => [a.id, a.platform, a.display_name ?? "-", a.brand_label ?? "-", a.needs_reconnect_at ? "needs reconnect" : "ok"])));
      };
    }

    case "rules": {
      if (parsed.positional.length > 1) throw new UsageError(`Unexpected extra argument: ${parsed.positional[1]}`);
      const platform = parsed.positional[0];
      return async (c, io) => {
        const rules = await c.rules.get(platform);
        if (io.json) return printJson(io, rules);
        if (!platform) {
          io.line(
            table(
              ["PLATFORM", "TEXT", "IMAGE", "VIDEO", "REQUIRED"],
              rules.platforms.map((p) => [p.platform, p.text.maxLength === null ? "-" : String(p.text.maxLength), p.media.image.supported ? "yes" : "no", p.media.video.supported ? "yes" : "no", p.required.join(", ")]),
            ),
          );
          io.line();
          io.line("Run lazyrelay rules <platform> for the full rules.");
          return;
        }
        for (const p of rules.platforms) {
          io.line(`${p.label} (${p.platform})`);
          io.line(`  Text: ${p.text.maxLength === null ? "no fixed limit" : `${p.text.maxLength} characters`}. ${p.text.note}`);
          io.line(`  Image: ${p.media.image.supported ? `${p.media.image.formats.join(", ")}${p.media.image.maxSizeMb ? `, up to ${p.media.image.maxSizeMb} MB` : ""}` : "not supported"}`);
          io.line(`  Video: ${p.media.video.supported ? `${p.media.video.formats.join(", ")}${p.media.video.maxSizeMb ? `, up to ${p.media.video.maxSizeMb} MB` : ""}${p.media.video.maxDurationSec ? `, up to ${p.media.video.maxDurationSec} s` : ""}` : "not supported"}`);
          if (p.media.multiItem) io.line(`  Several images: up to ${p.media.multiItem.maxItems}${p.media.multiItem.videosAllowed ? " (videos allowed)" : ""}`);
          io.line(`  Text only: ${p.media.textOnlyAllowed ? "allowed" : "not allowed, needs media"}`);
          io.line(`  Required: ${p.required.join(", ")}`);
          if (p.features.length) io.line(`  Features: ${p.features.join(", ")}`);
          for (const o of p.options) io.line(`  Option ${o}`);
          io.line(`  Limit: ${p.limits.note}`);
          for (const n of p.notes) io.line(`  Note: ${n}`);
        }
      };
    }

    case "posts list": {
      noPositional(parsed);
      const status = parsed.values.status as PostStatus | undefined;
      if (status && !STATUSES.includes(status)) throw new UsageError(`--status must be one of: ${STATUSES.join(", ")}.`);
      const limit = parsed.values.limit === undefined ? undefined : parseCount(parsed.values.limit, "--limit");
      const account = parsed.values.account;
      return async (c, io) => {
        const posts = await c.posts.list({ status, socialAccountId: account, limit });
        if (io.json) return printJson(io, posts);
        if (posts.length === 0) return io.line("No posts found.");
        io.line(postsTable(posts));
      };
    }

    case "posts history": {
      noPositional(parsed);
      const limit = parsed.values.limit === undefined ? undefined : parseCount(parsed.values.limit, "--limit");
      if (limit !== undefined && limit > 100) throw new UsageError("--limit can be at most 100.");
      return async (c, io) => {
        const posts = await c.posts.history({ limit, before: parsed.values.before });
        if (io.json) return printJson(io, posts);
        if (posts.length === 0) return io.line("No older posts found.");
        io.line(postsTable(posts));
      };
    }

    case "posts reschedule": {
      const id = needPositional(parsed, "id", path);
      if (!parsed.values.at?.trim()) throw new UsageError("Missing --at. Run lazyrelay posts reschedule --help for usage.");
      const ms = Date.parse(parsed.values.at);
      if (Number.isNaN(ms)) throw new UsageError("--at must be an ISO 8601 time, for example 2026-10-01T09:00:00Z.");
      const at = new Date(ms).toISOString();
      return async (c, io) => {
        const post = await c.posts.reschedule(id, at);
        if (io.json) return printJson(io, post);
        io.line(`Rescheduled post ${post.id} for ${formatTime(post.scheduled_for)} (status: ${post.status}).`);
      };
    }

    case "posts pause":
    case "posts resume": {
      const id = needPositional(parsed, "id", path);
      const pausing = path === "posts pause";
      return async (c, io) => {
        const post = await (pausing ? c.posts.pause(id) : c.posts.resume(id));
        if (io.json) return printJson(io, post);
        io.line(`${pausing ? "Paused" : "Resumed"} post ${post.id}.`);
      };
    }

    case "tiktok": {
      const id = needPositional(parsed, "accountId", path);
      return async (c, io) => {
        const info = await c.tiktok.creatorInfo(id);
        if (io.json) return printJson(io, info);
        io.line(`Nickname: ${info.nickname ?? "-"}`);
        io.line(`Can post now: ${info.canPost ? "yes" : `no${info.cantPostReason ? ` (${info.cantPostReason})` : ""}`}`);
        io.line(`Longest video: ${info.maxVideoDurationSec ? `${info.maxVideoDurationSec} seconds` : "unknown"}`);
        io.line(`Privacy levels: ${info.privacyLevelOptions?.length ? info.privacyLevelOptions.join(", ") : "none returned"}`);
      };
    }

    case "boards": {
      const id = needPositional(parsed, "accountId", path);
      return async (c, io) => {
        const boards = await c.pinterest.boards(id);
        if (io.json) return printJson(io, boards);
        if (boards.length === 0) return io.line("No boards found. Only Pinterest accounts have boards.");
        io.line(table(["ID", "NAME"], boards.map((b) => [b.id, b.name])));
      };
    }

    case "review create": {
      noPositional(parsed);
      const days = parsed.values.days === undefined ? undefined : parseCount(parsed.values.days, "--days");
      if (days !== undefined && days > 90) throw new UsageError("--days can be at most 90.");
      return async (c, io) => {
        const link = await c.reviewLinks.create({ label: parsed.values.label, brandLabel: parsed.values.brand, expiresInDays: days });
        if (io.json) return printJson(io, link);
        io.line(`Client review link (expires ${formatTime(link.expiresAt)}):`);
        io.line(link.url);
      };
    }

    case "review list": {
      noPositional(parsed);
      return async (c, io) => {
        const list = await c.reviewLinks.list();
        if (io.json) return printJson(io, list);
        if (list.links.length === 0) return io.line("No review links yet.");
        io.line(table(["ID", "LABEL", "STATUS", "EXPIRES", "URL"], list.links.map((l) => [l.id, l.label ?? "-", l.status, formatTime(l.expiresAt), `https://lazyrelay.com/review/${l.token}`])));
      };
    }

    case "review revoke": {
      const id = needPositional(parsed, "id", path);
      return async (c, io) => {
        const res = await c.reviewLinks.revoke(id);
        if (io.json) return printJson(io, res);
        io.line(`Revoked review link ${id}.`);
      };
    }

    case "posts schedule":
    case "posts now": {
      noPositional(parsed);
      const missing = ["account", "text", ...(path === "posts schedule" ? ["at"] : [])].filter((f) => !parsed.values[f]?.trim());
      if (missing.length) throw new UsageError(`Missing ${missing.map((m) => `--${m}`).join(", ")}. Run lazyrelay ${path} --help for usage.`);
      let at: string | undefined;
      if (path === "posts schedule") {
        const ms = Date.parse(parsed.values.at);
        if (Number.isNaN(ms)) throw new UsageError("--at must be an ISO 8601 time, for example 2026-10-01T09:00:00Z.");
        at = new Date(ms).toISOString();
      }
      const fields = composeFields(parsed);
      const media = parsed.lists.media ?? [];
      for (const m of media) if (!isUrl(m) && !isFile(m)) throw new UsageError(`Media file not found: ${m}`);
      return async (c, io) => {
        const mediaUrls: string[] = [];
        for (const m of media) {
          if (isUrl(m)) {
            mediaUrls.push(m);
            continue;
          }
          const uploaded = await c.media.upload(m);
          if (!io.json) io.line(`Uploaded ${m}: ${uploaded.url}`);
          mediaUrls.push(uploaded.url);
        }
        const post: PostFields = { ...fields };
        if (mediaUrls.length > 0) post.mediaUrl = mediaUrls[0];
        if (mediaUrls.length > 1) post.mediaUrls = mediaUrls.slice(1);
        const base = { ...post, socialAccountId: parsed.values.account, content: parsed.values.text, ...(parsed.bools.has("approval") ? { requiresApproval: true } : {}) };
        if (path === "posts schedule") {
          const created = await c.posts.schedule({ ...base, scheduledFor: at as string } as SchedulePostInput);
          if (io.json) return printJson(io, created);
          io.line(`Scheduled post ${created.id} for ${formatTime(created.scheduled_for)} (status: ${created.status}).`);
        } else {
          const created = await c.posts.publishNow(base as PublishNowInput);
          if (io.json) return printJson(io, created);
          io.line(`Queued post ${created.id} for immediate publishing (status: ${created.status}).`);
          io.line("It is not live yet. Check with: lazyrelay posts list --status posted");
        }
      };
    }

    case "posts delete": {
      const id = needPositional(parsed, "id", path);
      return async (c, io) => {
        await c.posts.delete(id);
        if (io.json) return printJson(io, { deleted: true, id });
        io.line(`Deleted post ${id}.`);
      };
    }

    case "posts approve": {
      const id = needPositional(parsed, "id", path);
      return async (c, io) => {
        const post = await c.posts.approve(id);
        if (io.json) return printJson(io, post);
        io.line(`Approved post ${post.id} (status: ${post.status}).`);
      };
    }

    case "proof": {
      const id = needPositional(parsed, "id", path);
      return async (c, io) => {
        const proof = await c.posts.proofLink(id);
        if (io.json) return printJson(io, proof);
        io.line(proof.url);
      };
    }

    case "media upload": {
      const file = needPositional(parsed, "file", path);
      if (!isFile(file)) throw new UsageError(`File not found: ${file}`);
      return async (c, io) => {
        const media = await c.media.upload(file, { altText: parsed.values.alt });
        if (io.json) return printJson(io, media);
        io.line(`Uploaded: ${media.url}`);
        io.line(`Media id: ${media.id}`);
      };
    }

    case "slots next": {
      const id = needPositional(parsed, "accountId", path);
      return async (c, io) => {
        const next = await c.slots.next(id);
        if (io.json) return printJson(io, next);
        io.line(next.scheduledFor);
      };
    }

    case "analytics": {
      noPositional(parsed);
      const days = parsed.values.days === undefined ? undefined : parseCount(parsed.values.days, "--days");
      if (days !== undefined && days > 90) throw new UsageError("--days can be at most 90.");
      return async (c, io) => {
        const s = await c.analytics.summary({ days, tag: parsed.values.tag, brand: parsed.values.brand });
        if (io.json) return printJson(io, s);
        const rate = s.verifiedLiveRate === null ? "n/a" : `${Math.round(s.verifiedLiveRate * 100)}%`;
        io.line(`Last ${s.rangeDays} days: ${s.totalPosts} post${s.totalPosts === 1 ? "" : "s"}, verified live rate ${rate}`);
        const status = Object.entries(s.byStatus ?? {}).map(([k, v]) => `${k} ${v}`).join(", ");
        if (status) io.line(`Status: ${status}`);
        const platforms = Object.entries(s.byPlatform ?? {});
        if (platforms.length) {
          io.line();
          io.line(table(["PLATFORM", "TOTAL", "POSTED", "FAILED", "LIVE"], platforms.map(([p, v]) => [p, String(v.total), String(v.posted), String(v.failed), String(v.verifiedLive)])));
        }
        const engagement = Object.entries(s.engagement ?? {});
        if (engagement.length) {
          io.line();
          io.line(table(["PLATFORM", "LIKES", "COMMENTS", "SHARES", "VIEWS"], engagement.map(([p, v]) => [p, String(v.likes), String(v.comments), String(v.shares), String(v.views)])));
        }
        if (s.availableTags?.length) {
          io.line();
          io.line(`Tags in use: ${s.availableTags.join(", ")}`);
        }
      };
    }
  }
  throw new UsageError(`Unknown command: ${path}`);
}

function postsTable(posts: ScheduledPost[]): string {
  return table(
    ["ID", "STATUS", "WHEN", "ACCOUNT", "LIVE", "TEXT"],
    posts.map((p) => {
      const latest = p.post_results?.[0];
      return [p.id, p.status, formatTime(p.scheduled_for), p.social_account_id ?? "-", latest ? (latest.verified_live ? "yes" : "no") : "-", shorten(p.content, 50)];
    }),
  );
}

function parseCount(raw: string, flag: string): number {
  if (!/^\d+$/.test(raw) || Number(raw) < 1) throw new UsageError(`${flag} must be a whole number of 1 or more.`);
  return Number(raw);
}

const isUrl = (s: string) => /^https?:\/\//i.test(s);

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** The post fields that come from flags (everything except account, text, time and media). */
function composeFields(parsed: ParsedArgs): PostFields {
  const fields: PostFields = {};
  if (parsed.values.tag !== undefined) {
    const tags = parsed.values.tag.split(",").map((t) => t.trim()).filter(Boolean);
    if (tags.length === 0) throw new UsageError("--tag needs at least one label, for example --tag launch,spring.");
    fields.tags = tags;
  }
  if (parsed.values.privacy !== undefined) fields.tiktokPrivacyLevel = parsed.values.privacy.trim().toUpperCase() as PostFields["tiktokPrivacyLevel"];
  if (parsed.values.board !== undefined) fields.boardId = parsed.values.board;
  if (parsed.values.link !== undefined) fields.destinationLink = parsed.values.link;
  if (parsed.values.options !== undefined) {
    let options: unknown;
    try {
      options = JSON.parse(parsed.values.options);
    } catch {
      throw new UsageError(`--options must be valid JSON, for example '{"instagram":{"placement":"reel"}}'.`);
    }
    if (typeof options !== "object" || options === null || Array.isArray(options)) throw new UsageError("--options must be a JSON object.");
    fields.options = options as PostFields["options"];
  }
  return fields;
}
