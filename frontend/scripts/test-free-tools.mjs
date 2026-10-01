// Tests the post checker logic against the JSON embedded in the page.
// Run: node frontend/scripts/test-free-tools.mjs   (after generate-free-tools.mjs)
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import assert from "node:assert/strict";

const here = dirname(fileURLToPath(import.meta.url));
const dir = join(here, "..", "public", "free-tools");
const html = readFileSync(join(dir, "post-checker", "index.html"), "utf8");
const data = JSON.parse(html.match(/<script type="application\/json" id="rules-data">([\s\S]*?)<\/script>/)[1]);
const logic = html.match(/<script id="checker-logic">([\s\S]*?)<\/script>/)[1];
const ctx = { TextEncoder, Intl, module: { exports: {} } };
vm.createContext(ctx);
vm.runInContext(logic, ctx);
const L = ctx.module.exports;
const P = (id) => data.platforms.find((p) => p.platform === id);
const run = (id, o) => L.check(P(id), { text: "", images: 0, video: false, ...o });

let n = 0;
const t = (name, fn) => { fn(); n++; console.log("ok  " + name); };

t("17 platforms, no X", () => { assert.equal(data.platforms.length, 17); assert.ok(!P("x")); });
t("Slack is in the checker: text only, 4000 characters", () => { assert.ok(P("slack")); assert.equal(P("slack").text.maxLength, 4000); assert.equal(P("slack").media.imageSupported, false); });
t("bluesky limit from repo data is 300", () => assert.equal(P("bluesky").text.maxLength, 300));
t("301 chars fails Bluesky, 300 passes", () => {
  assert.equal(run("bluesky", { text: "a".repeat(301) }).overall, "fail");
  assert.equal(run("bluesky", { text: "a".repeat(300) }).overall, "ok");
});
t("4 images pass Mastodon, 5 fail", () => {
  assert.equal(run("mastodon", { images: 4 }).media.status, "ok");
  assert.equal(run("mastodon", { images: 5 }).media.status, "fail");
});
t("video fails dev.to", () => assert.equal(run("devto", { video: true }).media.status, "fail"));
t("null limit is unverified, never a number", () => {
  for (const p of data.platforms.filter((x) => x.text.maxLength === null)) {
    const r = run(p.platform, { text: "a".repeat(100000) });
    assert.equal(r.text.status, "unverified", p.platform);
    assert.equal(r.text.limit, null, p.platform);
    assert.match(r.text.message, /No published limit that we could verify/);
  }
});
t("TikTok 2200 ok, 2201 fails; images and text-only fail", () => {
  assert.equal(run("tiktok", { text: "a".repeat(2200), video: true }).overall, "ok");
  assert.equal(run("tiktok", { text: "a".repeat(2201), video: true }).overall, "fail");
  assert.equal(run("tiktok", { images: 1 }).media.status, "fail");
  assert.equal(run("tiktok", {}).media.status, "fail");
});
t("TikTok counts UTF-16 (emoji = 2)", () => assert.equal(run("tiktok", { text: "\u{1F600}" }).text.used, 2));
t("Bluesky counts graphemes (emoji = 1)", () => assert.equal(run("bluesky", { text: "\u{1F600}" }).text.used, 1));
t("YouTube counts bytes (5002 bytes fails)", () => assert.equal(run("youtube", { text: "é".repeat(2501), video: true }).text.status, "over"));
t("Telegram caption limit applies only with media", () => {
  assert.equal(run("telegram", { text: "a".repeat(1025) }).overall, "ok");
  assert.equal(run("telegram", { text: "a".repeat(1025), images: 1 }).overall, "fail");
});
t("Lemmy limit applies to first line", () => {
  assert.equal(run("lemmy", { text: "a".repeat(200) + "\n" + "b".repeat(500) }).text.status, "ok");
  assert.equal(run("lemmy", { text: "a".repeat(201) }).text.status, "over");
});
t("Instagram needs media; 10 images ok, 11 fail; video + images ok", () => {
  assert.equal(run("instagram", {}).media.status, "fail");
  assert.equal(run("instagram", { images: 10 }).media.status, "ok");
  assert.equal(run("instagram", { images: 11 }).media.status, "fail");
  assert.equal(run("instagram", { images: 2, video: true }).media.status, "ok");
});
t("Facebook: video plus images fails (images only in multi-item)", () => assert.equal(run("facebook", { images: 2, video: true }).media.status, "fail"));
t("no em or en dashes in tool pages", () => {
  for (const f of ["index.html", join("post-checker", "index.html")]) {
    assert.ok(!/[–—]|&mdash;|&ndash;/.test(readFileSync(join(dir, f), "utf8")), f);
  }
});

console.log(`\n${n} tests passed`);
