// Every billing route that changes anything (checkout, change plan, cancel, and the storage, brand and seat add-ons)
// must be human-only: a customer API key must never be able to start, change or cancel a subscription. The routes are
// hidden from the public API document, but hiding is not blocking, so this guards the middleware itself.
// A source check, not a request test: the billing router pulls in the payment provider's SDK and the database client,
// neither of which exists in a plain test run, and the thing that matters here is that the guard is on every route.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "billing.routes.ts"), "utf8");
const routeLines = source.split(/\r?\n/).filter((l) => /^\s*router\.(get|post|put|patch|delete)\(/.test(l));

describe("billing routes are human-only where they change anything", () => {
  const writes = routeLines.filter((l) => /router\.(post|put|patch|delete)\(/.test(l));

  it("finds the nine changing routes, so the check cannot pass by matching nothing", () => {
    expect(writes).toHaveLength(9);
  });

  it("every changing route has requireHumanAuth after requireAuth and before requireOwner", () => {
    for (const line of writes) {
      expect(line, line.trim()).toMatch(/requireAuth,\s*requireHumanAuth,\s*requireOwner,/);
    }
  });

  it("the read-only routes stay open to API keys, as before", () => {
    const reads = routeLines.filter((l) => /router\.get\(/.test(l));
    expect(reads.length).toBeGreaterThanOrEqual(4);
    for (const line of reads) expect(line).not.toMatch(/requireHumanAuth/);
  });
});
