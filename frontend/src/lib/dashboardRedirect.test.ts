import { describe, it, expect } from "vitest";
import { dashboardRedirectTarget } from "./dashboardRedirect";

describe("dashboardRedirectTarget", () => {
  it("keeps the connect-flow query string when moving to /dashboard", () => {
    expect(dashboardRedirectTarget("/", "?selectAccount=abc-123")).toBe("/dashboard?selectAccount=abc-123");
    expect(dashboardRedirectTarget("/", "?connected=1")).toBe("/dashboard?connected=1");
    expect(dashboardRedirectTarget("/", "?connectError=Something%20failed")).toBe("/dashboard?connectError=Something%20failed");
    expect(dashboardRedirectTarget("/", "?prefillContent=hello")).toBe("/dashboard?prefillContent=hello");
  });

  it("never moves a signed-in visitor off a public token page, review links included", () => {
    const token = "a".repeat(43);
    expect(dashboardRedirectTarget("/review/" + token, "")).toBeNull();
    for (const p of ["/connect/bluesky", "/bio/my-page", "/verify/abc", "/feedback/abc"]) expect(dashboardRedirectTarget(p, "")).toBeNull();
  });

  it("still goes to plain /dashboard when there is no query string", () => {
    expect(dashboardRedirectTarget("/", "")).toBe("/dashboard");
    expect(dashboardRedirectTarget("/pricing", "")).toBe("/dashboard");
  });

  it("leaves /dashboard (with or without a trailing slash) alone", () => {
    expect(dashboardRedirectTarget("/dashboard", "")).toBeNull();
    expect(dashboardRedirectTarget("/dashboard/", "?selectAccount=x")).toBeNull();
    expect(dashboardRedirectTarget("/dashboard", "?connected=1")).toBeNull();
  });

  it("never redirects away from the self-owned pages", () => {
    for (const path of ["/connect/bluesky", "/bio/some-page", "/verify/abc", "/feedback/xyz", "/oauth/consent", "/team/accept", "/docs", "/reset-password"]) {
      expect(dashboardRedirectTarget(path, "?x=1")).toBeNull();
    }
  });
});
