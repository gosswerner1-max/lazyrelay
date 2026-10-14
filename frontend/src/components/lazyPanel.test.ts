/// <reference types="node" />
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

// Entry-chunk guard (2026-10-14): the `motion` library must stay out of the entry bundle. Landing and the support
// widget may only reach the spring panel through LazySpringPanel (a React.lazy boundary), never import it statically.
const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");

describe("spring panel is code-split", () => {
  for (const file of ["../pages/Landing.tsx", "../components/SupportWidget.tsx"]) {
    it(`${file} imports LazySpringPanel, not SpringPanel or motion directly`, () => {
      const src = read(file);
      expect(src).toMatch(/from "(\.\.\/components|\.)\/LazySpringPanel"/);
      expect(src).not.toMatch(/from "(\.\.\/components|\.)\/SpringPanel"/);
      expect(src).not.toMatch(/from "motion\//);
    });
  }

  it("LazySpringPanel loads SpringPanel through a dynamic import", () => {
    const src = read("./LazySpringPanel.tsx");
    expect(src).toMatch(/lazy\(\(\) => import\("\.\/SpringPanel"\)/);
    expect(src).not.toMatch(/^import .* from "\.\/SpringPanel"/m);
  });
});
