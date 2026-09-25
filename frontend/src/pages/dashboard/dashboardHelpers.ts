// Module-level constants, helpers and hooks that used to sit at the top of
// Dashboard.tsx, needed by more than one of the files it was split into
// (2026-09-25). Moved verbatim — the only change is the added `export`.

import { useEffect, useState } from "react";
import { type SocialAccount } from "../../lib/api";
export const TOUR_SEEN_KEY = "lazyrelay_tour_seen";
// First-run "connect Google Calendar?" prompt (2026-08-30, Werner's idea) —
// same client-only localStorage pattern as the tour above, not a backend
// field, for the same reason: this is a one-time convenience nudge, not
// something that needs to sync across devices.
export const GCAL_PROMPT_SEEN_KEY = "lazyrelay_gcal_prompt_seen";

// Settings (2026-08-17, Werner) consolidates the three former separate tabs
// "Storage"/"Account"/"Billing" into one -- all three sections still exist
// unchanged, they just all render together under tab === "Settings" now
// instead of three separate dropdown entries. Settings and API Keys both
// promoted to the always-visible top bar, leaving only the four
// content/engagement tabs behind "More".
export const TABS = ["Overview", "Posts", "Calendar", "Analytics", "Mentions", "DMs", "Bio Page", "Social Platforms", "Settings", "API Keys"] as const;
export type Tab = (typeof TABS)[number];
export const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// Both Google integrations are built and working. Google's app verification
// review (set to false 2026-09-04 to hide both behind a "Coming soon" badge
// while it was pending) cleared 2026-09-05 -- flipped back to true so real
// customers can connect Google Calendar and Google Sheets.
export const GOOGLE_INTEGRATIONS_LIVE = true;

// Multi-brand filtering (2026-08-08) — matches the backend's
// UNBRANDED_FILTER_VALUE sentinel in routes.ts, used wherever a customer
// filters Overview/Posts/Calendar/Mentions/DMs/Analytics down to accounts
// that have no brand label set yet.
export const UNBRANDED_FILTER_VALUE = "__unbranded__";

// Display-only mirror of the backend's BRAND_LIMITS (brandLimits.ts), which is
// the real enforcer. Used to show "N/cap" and pre-disable the create control;
// the server still rejects an over-cap create regardless of this.
export const BRAND_LIMITS_DISPLAY: Record<string, number> = { free: 1, pro: 2, business: 4, enterprise: 7 };
export function brandCapFor(tier: string | undefined): number {
  return BRAND_LIMITS_DISPLAY[tier ?? "free"] ?? 1;
}

export function localDateKey(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// Used by drag-and-drop (2026-08-30) to preserve a post's time-of-day when
// it's dropped on a different day — matches Google Calendar's own drag
// behavior, and reuses handleReschedulePostTo's existing (date, time)
// signature rather than adding a parallel reschedule-by-ISO-string path.
export function localTimeKey(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

// A real phone-width check (2026-08-20) — the calendar's grid layouts
// (7 day columns, event text inline in cells) genuinely don't fit a real
// mobile screen: checked at 375px and the content was structurally
// present but visually unreadable (cells/columns 26-44px wide). Worth its
// own hook since two calendar sections need to branch on it (the month
// grid's cell content, and Week view's day count), not just CSS.
export function useIsMobile(breakpoint = 700): boolean {
  const [isMobile, setIsMobile] = useState(() => window.innerWidth < breakpoint);
  useEffect(() => {
    function onResize() {
      setIsMobile(window.innerWidth < breakpoint);
    }
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [breakpoint]);
  return isMobile;
}

export const TRIAGE_CATEGORY_LABELS: Record<string, string> = {
  angry_customer: "Angry customer",
  sales_question: "Sales question",
  question: "Question",
};

export function accountMatchesBrand(account: SocialAccount | undefined, brandFilter: string): boolean {
  if (!brandFilter) return true;
  if (!account) return false;
  const label = account.brand_label?.trim();
  if (brandFilter === UNBRANDED_FILTER_VALUE) return !label;
  return label === brandFilter;
}

// Minimal RFC4180-ish CSV parser — handles quoted fields, escaped ""
// quotes, and commas/newlines inside quotes. No external dependency for
// something this small; a customer's exported CSV (Sheets/Excel) is the
// realistic input shape this needs to survive, not arbitrary CSV exotica.
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') {
        inQuotes = false;
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((cell) => cell.trim() !== "")) rows.push(row);
      row = [];
    } else {
      field += c;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    if (row.some((cell) => cell.trim() !== "")) rows.push(row);
  }
  return rows;
}

// Read once at module scope (not inside the component) — React 18
// StrictMode double-mounts components in dev, and a component-scoped
// effect that reads-then-strips the URL loses the value on the second
// mount, since the window was already mutated by the first. Module
// evaluation only happens once per page load regardless of StrictMode.
export function readAndClearConnectParams(): {
  connectError: string | null;
  connected: boolean;
  selectAccount: string | null;
  prefillContent: string | null;
  prefillMediaUrl: string | null;
  gcalConnected: boolean;
  gcalConnectError: string | null;
  gsheetConnected: boolean;
  gsheetConnectError: string | null;
} {
  const params = new URLSearchParams(window.location.search);
  const connectError = params.get("connectError");
  const connected = params.get("connected") !== null;
  // Google Calendar's connect flow (backend routes.ts's
  // GET /google-calendar/callback) redirects here the same way the platform
  // connect flow does, with its own distinct param names so the two connect
  // flows' redirects can never be confused with each other.
  const gcalConnected = params.get("gcalConnected") !== null;
  const gcalConnectError = params.get("gcalConnectError");
  // Google Sheets' connect flow — same pattern, its own distinct param
  // names again so all three connect flows stay unambiguous.
  const gsheetConnected = params.get("gsheetConnected") !== null;
  const gsheetConnectError = params.get("gsheetConnectError");
  // Set when a connect has more than one real Page/account to choose from
  // (Facebook: multiple Pages; Instagram: whichever Page has a Business
  // Account linked) — see backend/src/platforms/connect.ts. Holds the
  // one-time selection token used to fetch and finalize the choice.
  const selectAccount = params.get("selectAccount");
  // Set by the browser extension's context-menu actions (see
  // browser-extension/background.js) — opens lazyrelay.com with one of
  // these params so the customer lands straight in the compose form
  // instead of having to copy/paste the URL themselves.
  const prefillContent = params.get("prefillContent");
  const prefillMediaUrl = params.get("prefillMediaUrl");
  if (
    connectError ||
    connected ||
    selectAccount ||
    prefillContent ||
    prefillMediaUrl ||
    gcalConnected ||
    gcalConnectError ||
    gsheetConnected ||
    gsheetConnectError
  ) {
    window.history.replaceState({}, "", window.location.pathname);
  }
  return {
    connectError,
    connected,
    selectAccount,
    prefillContent,
    prefillMediaUrl,
    gcalConnected,
    gcalConnectError,
    gsheetConnected,
    gsheetConnectError,
  };
}
export const connectParams = readAndClearConnectParams();
