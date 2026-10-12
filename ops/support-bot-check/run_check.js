#!/usr/bin/env node
// Support-bot check: asks the LIVE LazyRelay support bot a fixed list of questions
// (questions.json) and flags any answer that contradicts a fact we know is true.
// Run it after every deploy that touches chatKnowledge.ts or any public claim.
//
//   node run_check.js                  -> asks every question, prints a table
//   node run_check.js --only zapier-free,tiktok-public
//   node run_check.js --base https://other-host/api     (default: the live backend)
//   node run_check.js --questions other.json            (default: questions.json beside this file)
//
// Exit code: 0 = every answer passed, 1 = at least one answer contradicts a known
// fact, 2 = the bot could not be reached / gave no answer. This script only reads;
// it never changes anything. The bot is capped at 50 questions a day per IP, so
// keep this list short (10 questions per run).

const fs = require("fs");
const path = require("path");

const args = process.argv.slice(2);
const argValue = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; };
const BASE = (argValue("--base") || "https://lazyrelaylazyrelay-backend.onrender.com/api").replace(/\/$/, "");
const only = (argValue("--only") || "").split(",").map((s) => s.trim()).filter(Boolean);

const questionsFile = argValue("--questions") || path.join(__dirname, "questions.json");
const { questions } = JSON.parse(fs.readFileSync(questionsFile, "utf8"));
const selected = only.length ? questions.filter((q) => only.includes(q.id)) : questions;
if (!selected.length) { console.error("No matching questions."); process.exit(2); }

const re = (p) => new RegExp(p, "i");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function ask(question) {
  const res = await fetch(`${BASE}/support/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", content: question }] }),
    signal: AbortSignal.timeout(45000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} ${text.slice(0, 120)}`);
  const j = JSON.parse(text);
  if (typeof j.reply !== "string" || !j.reply.trim()) throw new Error("empty reply");
  return j.reply;
}

(async () => {
  const rows = [];
  let unreachable = 0;
  for (const q of selected) {
    try {
      const reply = await ask(q.ask);
      const missing = q.mustMatch.filter((p) => !re(p).test(reply));
      const banned = q.mustNotMatch.map((p) => { const m = reply.match(re(p)); return m ? m[0] : null; }).filter(Boolean);
      rows.push({ id: q.id, ok: !missing.length && !banned.length, missing, banned, reply });
    } catch (err) {
      unreachable++;
      rows.push({ id: q.id, ok: false, error: String(err.message || err), reply: "" });
    }
    await sleep(3000);
  }

  const pad = (s, n) => String(s).padEnd(n);
  console.log(`\nSupport-bot check against ${BASE}  (${new Date().toISOString()})\n`);
  for (const r of rows) {
    const status = r.error ? "ERROR" : r.ok ? "PASS " : "FAIL ";
    let why = "";
    if (r.error) why = r.error;
    else if (!r.ok) why = [r.banned.length ? `said: "${r.banned.join('", "')}"` : "", r.missing.length ? `missing: ${r.missing.length} expected pattern(s)` : ""].filter(Boolean).join("; ");
    console.log(`${status} ${pad(r.id, 18)} ${why}`);
  }
  const failed = rows.filter((r) => !r.ok && !r.error);
  for (const r of failed) console.log(`\n--- ${r.id}: full reply ---\n${r.reply}\n`);

  const passed = rows.filter((r) => r.ok).length;
  console.log(`\n${passed}/${rows.length} passed, ${failed.length} contradicted a known fact, ${unreachable} could not be asked.`);
  process.exitCode = unreachable ? 2 : failed.length ? 1 : 0;
})();
