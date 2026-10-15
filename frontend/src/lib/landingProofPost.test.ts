import { describe, expect, it } from "vitest";
import landingSource from "../pages/Landing.tsx?raw";

// The home page shows a real Proof-of-Publish post from the LazyRelay Mastodon account. The old one said "12 platforms",
// which contradicts the 17 platforms the site now states everywhere. Rewriting a real post would falsify the proof, so a
// new real post was published instead (https://mastodon.social/@lazyrelay/117445004212290706) and the home page shows
// that exact text. Pin both: no stale count, and the text matches the published post.
const PUBLISHED_TEXT =
  "Real talk: scheduling posts across 17 platforms should not mean logging into 17 dashboards. LazyRelay handles it from one place, with Proof-of-Publish confirming every post actually went live.";

describe("home page proof post", () => {
  it("does not state the old 12-platform count", () => {
    expect(landingSource).not.toMatch(/12 platforms/i);
    expect(landingSource).not.toMatch(/12 dashboards/i);
  });

  it("shows the exact text of the published Mastodon post", () => {
    expect(landingSource).toContain(PUBLISHED_TEXT);
  });
});
