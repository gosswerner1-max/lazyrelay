// Types and wording helpers for the Settings > Webhooks section. The server side
// is backend/src/webhook.ts and routes/webhooks.routes.ts.

export interface WebhookLastDelivery {
  status: "pending" | "sending" | "delivered" | "failed";
  createdAt: string;
  statusCode: number | null;
  error: string | null;
}

export interface WebhookEndpoint {
  id: string;
  label: string | null;
  url: string;
  events: string[]; // empty = every event
  socialAccountIds: string[] | null; // null = every channel
  enabled: boolean;
  createdAt: string;
  lastDelivery?: WebhookLastDelivery | null;
}

export interface WebhookList {
  maxEndpoints: number;
  availableEvents: string[];
  endpoints: WebhookEndpoint[];
}

export interface WebhookDelivery {
  id: string;
  event: string;
  status: "pending" | "sending" | "delivered" | "failed";
  attempts: number;
  statusCode: number | null;
  error: string | null;
  createdAt: string;
  deliveredAt: string | null;
}

export const EVENT_LABELS: Record<string, string> = {
  "post.verified": "Post confirmed live",
  "post.failed": "Post failed",
  "post.unconfirmed": "Post sent, not confirmed",
  "channel.needs_reconnect": "Account needs reconnecting",
  "webhook.test": "Test event",
};

export const eventLabel = (event: string): string => EVENT_LABELS[event] ?? event;

export function describeEvents(events: string[], available: string[]): string {
  if (events.length === 0 || events.length >= available.length) return "All events";
  return events.map(eventLabel).join(", ");
}

export function describeChannels(ids: string[] | null, channels: Array<{ id: string; label: string }>): string {
  if (!ids || ids.length === 0) return "All channels";
  const names = ids.map((id) => channels.find((c) => c.id === id)?.label ?? "a removed channel");
  return names.join(", ");
}

/** One plain line about how the latest delivery went. */
export function describeLastDelivery(d: WebhookLastDelivery | null | undefined, formatTime: (iso: string) => string = (iso) => new Date(iso).toLocaleString()): {
  text: string;
  tone: "none" | "ok" | "warn" | "bad";
} {
  if (!d) return { text: "Nothing sent yet", tone: "none" };
  const when = formatTime(d.createdAt);
  if (d.status === "delivered") return { text: `Last delivery worked (${when})`, tone: "ok" };
  if (d.status === "pending" || d.status === "sending") {
    return { text: `Last delivery is being retried (${when}). ${d.error ?? ""}`.trim(), tone: "warn" };
  }
  return { text: `Last delivery failed (${when}). ${d.error ?? ""}`.trim(), tone: "bad" };
}

export function describeDelivery(d: WebhookDelivery): string {
  const attempts = `${d.attempts} ${d.attempts === 1 ? "attempt" : "attempts"}`;
  if (d.status === "delivered") return `Delivered (${d.statusCode ?? "ok"}), ${attempts}`;
  if (d.status === "failed") return `Failed after ${attempts}${d.error ? `: ${d.error}` : ""}`;
  return `Retrying, ${attempts}${d.error ? `: ${d.error}` : ""}`;
}
