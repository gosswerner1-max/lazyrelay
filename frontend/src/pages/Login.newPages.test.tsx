/// <reference types="node" />
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The Login / Signup page can wear the Midnight Canvas glass card (canvas #0b0f19, panels #141b2d, locked orange #ff5630) behind
// VITE_NEW_PAGES_ENABLED === "true". The flag is off by default and then nothing changes. With the flag on, only class names and an
// extra decorative header are added: every field, label, message, validation rule, the security check and the Google button behave as before.
//   Wording rule: no purple or violet anywhere in the new stylesheet.

const signIn = vi.fn();
const signUp = vi.fn();
const signInWithGoogle = vi.fn();
vi.mock("../context/AuthContext", () => ({ useAuth: () => ({ signIn, signUp, signInWithGoogle }) }));
vi.mock("../lib/api", () => ({ api: { checkBusinessNameAvailability: vi.fn() } }));

import { Login } from "./Login";

const css = readFileSync(join(__dirname, "..", "styles", "new-pages-login.css"), "utf8");

beforeEach(() => {
  signIn.mockReset();
  signUp.mockReset();
  signInWithGoogle.mockReset();
});
afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

const renderLogin = (props: Partial<Parameters<typeof Login>[0]> = {}) =>
  render(<Login onBack={() => {}} onForgotPassword={() => {}} onTerms={() => {}} onPrivacy={() => {}} {...props} />);

describe("flag off (the default): the page is exactly the old page", () => {
  it("adds no glass class and no extra header", () => {
    const { container } = renderLogin();
    expect(container.querySelector(".auth-page--glass")).toBeNull();
    expect(container.querySelector(".auth-glass-top")).toBeNull();
    expect(container.querySelector(".auth-page.auth-page--compact")).not.toBeNull();
  });
  it("still shows the same fields and wording", () => {
    renderLogin();
    expect(screen.getByRole("button", { name: /Continue with Google/ })).toBeInTheDocument();
    expect(screen.getByLabelText("Email")).toBeInTheDocument();
    expect(screen.getByLabelText("Password")).toBeInTheDocument();
    expect(screen.getByText("Sign in to your account")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Forgot password?" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Need an account? Sign up" })).toBeInTheDocument();
  });
});

describe("flag on: the same page in the glass card", () => {
  beforeEach(() => vi.stubEnv("VITE_NEW_PAGES_ENABLED", "true"));

  it("wraps the page in the glass scope and adds a decorative header with plain links", () => {
    const { container } = renderLogin();
    const root = container.querySelector(".auth-page.auth-page--compact.auth-page--glass");
    expect(root).not.toBeNull();
    const nav = container.querySelector(".auth-glass-top nav") as HTMLElement;
    expect(nav).not.toBeNull();
    const hrefs = [...nav.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    expect(hrefs).toEqual(["/", "/capabilities/", "/pricing/", "/mcp/", "/guides/", "/docs/"]);
  });

  it("keeps every field, label, message and button of the old page", () => {
    const { container } = renderLogin();
    expect(screen.getByRole("button", { name: /Continue with Google/ })).toBeInTheDocument();
    expect(screen.getByLabelText("Email")).toHaveAttribute("type", "email");
    expect(screen.getByLabelText("Password")).toHaveAttribute("type", "password");
    expect(screen.getByLabelText("Email")).toBeRequired();
    expect(screen.getByLabelText("Password")).toBeRequired();
    expect(screen.getByText("Sign in to your account")).toBeInTheDocument();
    expect(container.querySelector("h1")).toHaveTextContent("Sign in to LazyRelay");
    expect(screen.getByRole("button", { name: "Forgot password?" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign in" })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Back to home/ })).toBeInTheDocument();
  });

  it("signup mode keeps its extra field, the password rule and the consent sentence", () => {
    renderLogin({ initialMode: "signup" });
    expect(screen.getByLabelText("What should we call you?")).toHaveAttribute("placeholder", "Your business or brand name");
    const pw = screen.getByLabelText(/Password/);
    expect(pw).toHaveAttribute("minlength", "10");
    expect(screen.getByText("At least 10 characters, with uppercase, lowercase, a number, and a symbol.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Terms of Service" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Privacy Policy" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Already have an account? Sign in" })).toBeInTheDocument();
  });

  it("the mode switch and the Terms button still work", () => {
    const onTerms = vi.fn();
    renderLogin({ onTerms });
    fireEvent.click(screen.getByRole("button", { name: "Need an account? Sign up" }));
    expect(screen.getByRole("button", { name: "Sign up" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Terms of Service" }));
    expect(onTerms).toHaveBeenCalledTimes(1);
  });

  it("the Google button still starts the Google sign in and shows its error", async () => {
    signInWithGoogle.mockResolvedValue({ error: "Google is unavailable" });
    renderLogin();
    fireEvent.click(screen.getByRole("button", { name: /Continue with Google/ }));
    expect(signInWithGoogle).toHaveBeenCalledTimes(1);
    expect(await screen.findByText("Google is unavailable")).toBeInTheDocument();
  });
});

describe("the glass stylesheet", () => {
  it("is scoped: every rule starts with the glass scope, so nothing else on the site changes", () => {
    const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "").replace(/@media[^{]*\{/g, "");
    const selectors = [...stripped.matchAll(/(^|[}\s])([^{}@]+)\{/g)].map((m) => m[2]!.trim()).filter((s) => !/^[\d.%\s]+$|^(from|to)$/.test(s));
    expect(selectors.length).toBeGreaterThan(20);
    for (const sel of selectors) for (const part of sel.split(",")) expect(part.trim(), part).toMatch(/^(\.auth-page--glass|\.auth-glass-top)/);
  });
  it("uses the locked palette", () => {
    for (const t of ["#0b0f19", "#141b2d", "#ff5630", "#ff7a58"]) expect(css.toLowerCase()).toContain(t);
  });
  it("has no purple or violet word or hue (hex hue 250 to 330)", () => {
    expect(css).not.toMatch(/purple|violet|lavender|indigo|magenta/i);
    for (const m of css.matchAll(/#([0-9a-fA-F]{6})\b/g)) {
      const [r, g, b] = [0, 2, 4].map((i) => parseInt(m[1]!.slice(i, i + 2), 16) / 255) as [number, number, number];
      const max = Math.max(r, g, b);
      const d = max - Math.min(r, g, b);
      if (d < 0.1) continue;
      let h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
      h = (h * 60 + 360) % 360;
      expect(h >= 250 && h <= 330, m[0]).toBe(false);
    }
  });
  it("carries the accessibility fallbacks", () => {
    for (const q of ["prefers-reduced-motion", "prefers-reduced-transparency", "prefers-contrast"]) expect(css).toContain(q);
  });
  it("loads nothing from another host", () => {
    expect(css).not.toMatch(/@import|url\(\s*["']?https?:/);
  });
});
