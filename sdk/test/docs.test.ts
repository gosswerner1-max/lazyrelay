import { existsSync, readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { LazyRelay } from "../src/index.js";

const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");

describe("README", () => {
  it("has no em dashes or en dashes", () => {
    expect(readme).not.toMatch(/[–—]/);
  });

  it("documents every SDK method", () => {
    const client = new LazyRelay({ apiKey: "lzr_live_x" });
    const missing: string[] = [];
    for (const [ns, resource] of Object.entries(client)) {
      const proto = Object.getPrototypeOf(resource) as object;
      for (const name of Object.getOwnPropertyNames(proto)) {
        if (name === "constructor") continue;
        // pause/resume share a row, so look for the bare name too.
        if (!readme.includes(`${ns}.${name}(`) && !readme.includes(`${ns}.${name}\``)) missing.push(`${ns}.${name}`);
      }
    }
    expect(missing).toEqual([]);
    expect(readme).toContain("verifyWebhookSignature");
  });

  it("documents every CLI command and states the thin client fact", () => {
    for (const cmd of ["whoami", "accounts", "rules", "posts list", "posts schedule", "posts now", "posts delete", "posts approve", "proof", "media upload", "slots next", "analytics", "help", "posts reschedule", "posts pause", "posts resume", "posts history", "tiktok", "boards", "review create", "review list", "review revoke"]) {
      expect(readme).toContain(`lazyrelay ${cmd}`);
    }
    expect(readme).toContain("thin typed client over the LazyRelay REST API");
    expect(readme).toContain("https://lazyrelay.com/docs");
  });

  it("says webhook endpoints are managed in the dashboard", () => {
    expect(readme).toMatch(/Settings, Webhooks/);
    expect(readme).toMatch(/cannot be managed with an API key/);
  });
});

describe("CLI source text", () => {
  it("has no em dashes or en dashes in the user facing files", () => {
    for (const file of ["cliCore.ts", "help.ts", "format.ts", "args.ts", "cli.ts"]) {
      const text = readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8");
      expect(text, file).not.toMatch(/[–—]/);
    }
  });
});

describe("package", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

  it("is shaped for publishing without publishing", () => {
    expect(pkg.name).toBe("@lazyrelay/sdk");
    expect(pkg.version).toBe("0.1.0");
    expect(pkg.type).toBe("module");
    expect(pkg.engines.node).toBe(">=18");
    expect(pkg.bin).toEqual({ lazyrelay: "dist/cli.js" });
    expect(pkg.files).toEqual(["dist", "README.md"]);
    expect(pkg.dependencies).toBeUndefined();
    expect(pkg.license).toBe("MIT"); // Werner chose MIT for the SDK and the n8n node, 2026-09-30
    expect(existsSync(new URL("../LICENSE", import.meta.url))).toBe(true);
  });

  it("the built output has the entry points and type declarations", () => {
    const dist = readdirSync(new URL("../dist", import.meta.url));
    for (const f of ["index.js", "index.d.ts", "cli.js", "types.d.ts"]) expect(dist).toContain(f);
    expect(readFileSync(new URL("../dist/cli.js", import.meta.url), "utf8").startsWith("#!/usr/bin/env node")).toBe(true);
  });
});
