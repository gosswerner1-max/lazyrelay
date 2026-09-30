// Each platform's own documented "force login / choose account" authorize-URL option,
// so a browser already logged into another account can't silently connect the wrong one.
// No network: getAuthorizeUrl only builds a URL.

import { describe, it, expect } from "vitest";
import { YouTubeAdapter } from "./youtube.js";
import { TumblrAdapter } from "./tumblr.js";
import { TikTokAdapter } from "./tiktok.js";

describe("authorize URL account-chooser params", () => {
  it("YouTube asks Google for the account chooser and keeps consent + offline access", async () => {
    const u = new URL(await new YouTubeAdapter("id", "s", "https://x/cb").getAuthorizeUrl("st"));
    expect(u.searchParams.get("prompt")).toBe("select_account consent");
    expect(u.searchParams.get("access_type")).toBe("offline");
  });

  it("Tumblr sends force_login=true", async () => {
    const u = new URL(await new TumblrAdapter("id", "s", "https://x/cb").getAuthorizeUrl("st"));
    expect(u.searchParams.get("force_login")).toBe("true");
    expect(u.searchParams.get("state")).toBe("st");
  });

  it("TikTok sends disable_auto_auth=1", async () => {
    const u = new URL(await new TikTokAdapter("k", "s", "https://x/cb").getAuthorizeUrl("st"));
    expect(u.searchParams.get("disable_auto_auth")).toBe("1");
    expect(u.searchParams.get("client_key")).toBe("k");
  });
});
