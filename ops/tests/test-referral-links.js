// Tests for ops/shared/referralLinks.js (unique partner codes and tracked referral links). No network, no database.
// Run: node ops/tests/test-referral-links.js
const assert = require("node:assert/strict");
const { generatePartnerCode, buildReferralUrl, readReferralParams, isPaddleSafe, slugify, CODE_RE, RESERVED } = require("../shared/referralLinks.js");

let pass = 0;
function t(label, fn) {
  try { fn(); pass++; console.log("PASS:", label); } catch (e) { console.error("FAIL:", label, "-", e.message); process.exitCode = 1; }
}
const seq = (...nums) => { let i = 0; return (max) => nums[i++ % nums.length] % max; }; // a repeatable "random" source for tests

t("slugify removes accents, spaces and symbols, lower-cases and keeps 10 characters", () => {
  assert.equal(slugify("Sarah Köhler"), "sarahkohle");
  assert.equal(slugify("  A.B. & Co!  "), "abco");
  assert.equal(slugify("Wolfeschlegelsteinhausen"), "wolfeschle");
  assert.equal(slugify(null), "");
});

t("a free name becomes the code as it is", () => {
  assert.equal(generatePartnerCode("Sarah", () => false), "sarah");
});

t("a taken name gets a short suffix and the result is free, valid and different", () => {
  const taken = new Set(["sarah"]);
  const c = generatePartnerCode("Sarah", (x) => taken.has(x), seq(0, 1));
  assert.notEqual(c, "sarah");
  assert.match(c, CODE_RE);
  assert.ok(c.startsWith("sarah"));
});

t("a code that is too short, or a reserved word, is never handed out as it is", () => {
  assert.match(generatePartnerCode("Al", () => false, seq(3, 4)), CODE_RE);
  const c = generatePartnerCode("Support", () => false, seq(3, 4));
  assert.ok(!RESERVED.has(c) && c.startsWith("support") && c !== "support");
  const lr = generatePartnerCode("LazyRelay", () => false, seq(5, 6));
  assert.notEqual(lr, "lazyrelay");
});

t("an empty or symbol-only name still gives a valid code", () => {
  assert.match(generatePartnerCode("", () => false, seq(1, 2)), CODE_RE);
  assert.match(generatePartnerCode("!!!", () => false, seq(7, 8)), CODE_RE);
});

t("2,000 random names never produce a code Paddle would refuse, or one that is taken", () => {
  const taken = new Set();
  let x = 12345;
  const rnd = (n) => ((x = (x * 1103515245 + 12345) & 0x7fffffff), (x >>> 8) % n);
  for (let i = 0; i < 2000; i++) {
    let name = "";
    for (let j = 0; j < 1 + rnd(14); j++) name += "abcdefghij klmnop-qrstu.Ã©ö 0123"[rnd(31)];
    const c = generatePartnerCode(name, (v) => taken.has(v), rnd);
    assert.match(c, CODE_RE);
    assert.ok(isPaddleSafe(c), c);
    assert.ok(!taken.has(c), "duplicate " + c);
    assert.ok(!RESERVED.has(c));
    taken.add(c);
  }
});

t("when every try is taken it stops with an error instead of looping for ever", () => {
  assert.throws(() => generatePartnerCode("Sarah", () => true, seq(1)), /free partner code/);
});

t("isPaddleSafe: letters and numbers only, 1 to 32", () => {
  assert.ok(isPaddleSafe("sarah7"));
  assert.ok(!isPaddleSafe("sarah-7"));
  assert.ok(!isPaddleSafe(""));
  assert.ok(!isPaddleSafe("a".repeat(33)));
});

t("Plan B link carries ref and the utm words, in a fixed order", () => {
  assert.equal(buildReferralUrl({ code: "Sarah", plan: "B" }), "https://lazyrelay.com/?ref=sarah&utm_source=partner&utm_medium=referral&utm_campaign=sarah");
});

t("Plan A link carries promo AND ref, so the discount applies and signup is still captured", () => {
  const u = new URL(buildReferralUrl({ code: "sarah", plan: "A", channel: "youtube" }));
  assert.equal(u.searchParams.get("promo"), "sarah");
  assert.equal(u.searchParams.get("ref"), "sarah");
  assert.equal(u.searchParams.get("utm_content"), "youtube");
  assert.equal(u.origin, "https://lazyrelay.com");
});

t("the link can point at any page of the site, and no tracking words when asked", () => {
  assert.equal(buildReferralUrl({ code: "sarah", plan: "B", path: "/pricing/", utm: false }), "https://lazyrelay.com/pricing/?ref=sarah");
});

t("bad input is refused: code, plan, path, channel, and a hyphen code on Plan A", () => {
  assert.throws(() => buildReferralUrl({ code: "a b" }), /valid partner code/);
  assert.throws(() => buildReferralUrl({ code: "ab" }), /valid partner code/);
  assert.throws(() => buildReferralUrl({ code: "sarah", plan: "C" }), /plan/);
  assert.throws(() => buildReferralUrl({ code: "sarah", path: "pricing" }), /path/);
  assert.throws(() => buildReferralUrl({ code: "sarah", path: "//evil.example/x" }), /path/);
  assert.throws(() => buildReferralUrl({ code: "sarah", path: "/a?b=1" }), /path/);
  assert.throws(() => buildReferralUrl({ code: "sarah", channel: "You Tube" }), /channel/);
  assert.throws(() => buildReferralUrl({ code: "my-code", plan: "A" }), /Paddle/);
  assert.doesNotThrow(() => buildReferralUrl({ code: "my-code", plan: "B" })); // an older hyphen code still works on Plan B
});

t("what the link says is exactly what the website reads back (round trip)", () => {
  for (const plan of ["A", "B"]) {
    const u = new URL(buildReferralUrl({ code: "Sarah7", plan, channel: "newsletter" }));
    const r = readReferralParams(u.search);
    assert.equal(r.ref, "sarah7");
    assert.equal(r.promo, plan === "A" ? "sarah7" : null);
  }
});

t("readReferralParams: trims, lower-cases, refuses empty and over-long values", () => {
  assert.deepEqual(readReferralParams("?ref=%20SaRaH%20"), { ref: "sarah", promo: null });
  assert.deepEqual(readReferralParams("?ref=&promo="), { ref: null, promo: null });
  assert.deepEqual(readReferralParams("?ref=" + "a".repeat(41)), { ref: null, promo: null });
  assert.deepEqual(readReferralParams(""), { ref: null, promo: null });
});

// The add-partner command with a pretend database (no network): "auto" makes a free code, Plan A refuses a code Paddle would refuse.
const { addPartner } = require("../reports/referral_report.js");
const fakeDb = (existing) => {
  const inserted = [];
  return {
    inserted,
    from: () => ({
      select: async () => ({ data: existing.map((code) => ({ code })), error: null }),
      insert: async (row) => { inserted.push(row); return { error: null }; },
    }),
  };
};
const quiet = async (fn) => { const log = console.log; const lines = []; console.log = (m) => lines.push(String(m)); try { await fn(); } finally { console.log = log; } return lines; };

(async () => {
  try {
    const db = fakeDb(["sarah"]);
    const lines = await quiet(() => addPartner(db, "auto", "Sarah", "sarah@example.com", "B"));
    assert.equal(db.inserted.length, 1);
    assert.notEqual(db.inserted[0].code, "sarah");
    assert.ok(db.inserted[0].code.startsWith("sarah"));
    assert.ok(lines.some((l) => l.includes(`?ref=${db.inserted[0].code}&utm_source=partner`)));
    pass++; console.log("PASS: add-partner with code auto picks a free code and prints the tracked link");

    const db2 = fakeDb([]);
    await assert.rejects(() => addPartner(db2, "my-code", "Sam", "sam@example.com", "A"), /Paddle/);
    assert.equal(db2.inserted.length, 0);
    pass++; console.log("PASS: Plan A refuses a hyphen code before anything is saved");

    const db3 = fakeDb([]);
    const l3 = await quiet(() => addPartner(db3, "my-code", "Sam", "sam@example.com", "B"));
    assert.equal(db3.inserted[0].code, "my-code");
    assert.ok(l3.some((l) => l.includes("lazyrelay.com/?ref=my-code")));
    pass++; console.log("PASS: Plan B still accepts an older style hyphen code");
  } catch (e) {
    console.error("FAIL:", e.message);
    process.exitCode = 1;
  }
  console.log(`\n${pass} tests passed${process.exitCode ? ", SOME FAILED" : ""}`);
})();
