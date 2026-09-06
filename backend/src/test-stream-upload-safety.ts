import { fetchMediaForStreaming } from "./platforms/streamUpload.js";

// Real, live verification for the 2026-09-06 fetchMediaForStreaming
// fix — proves the fetch-time safety re-check actually blocks an unsafe
// URL (not just that isSafeMediaUrl itself does, which test-url-safety.ts
// already covers), and that a genuinely safe, real public URL still works
// normally afterward.

let failures = 0;
function report(label: string, pass: boolean, detail?: string) {
  console.log(`${pass ? "PASS" : "FAIL"} — ${label}${detail ? `: ${detail}` : ""}`);
  if (!pass) failures++;
}

async function main() {
  console.log("=== fetchMediaForStreaming safety re-check ===\n");

  // A real, publicly-reachable HTTPS URL a customer's mediaUrl could
  // legitimately be (this is what LazyRelay's own upload flow produces,
  // approximated here with any stable real https resource) -- confirms the
  // new safety check doesn't block a genuinely safe fetch that used to work.
  const safeResult = await fetchMediaForStreaming("https://raw.githubusercontent.com/octocat/Hello-World/master/README");
  report("A real, safe public HTTPS URL still fetches successfully", safeResult !== null, JSON.stringify(!!safeResult));

  // The exact class this fix closes: a URL that would have passed
  // postCreation.ts's write-time check (if it resolved to a public address
  // back then) but now resolves to the cloud-metadata address at actual
  // send time. Using the literal metadata IP directly is the simplest real
  // proof, since isSafeMediaUrl rejects the literal IP the same way it
  // would reject a hostname that currently resolves to it.
  const blockedResult = await fetchMediaForStreaming("https://169.254.169.254/latest/meta-data/");
  report(
    "A URL now pointing at the cloud-metadata address is REJECTED at fetch time, not just fetched blindly",
    blockedResult === null,
    JSON.stringify(blockedResult),
  );

  const blockedLocalhost = await fetchMediaForStreaming("https://localhost/x");
  report("A URL pointing at localhost is REJECTED at fetch time", blockedLocalhost === null, JSON.stringify(blockedLocalhost));

  console.log(`\n=== ${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`} ===`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
