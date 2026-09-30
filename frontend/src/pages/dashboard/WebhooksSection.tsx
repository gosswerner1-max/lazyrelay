import { useCallback, useEffect, useState, type FormEvent } from "react";
import { CodeBlock } from "../../components/CodeBlock";
import { api } from "../../lib/api";
import {
  describeChannels,
  describeDelivery,
  describeEvents,
  describeLastDelivery,
  eventLabel,
  type WebhookDelivery,
  type WebhookEndpoint,
  type WebhookList,
} from "../../lib/webhooks";

// Settings > Webhooks: several endpoints, a choice of events and channels per
// endpoint, a test button and a delivery log. Self-contained on purpose (its own
// state, no reliance on the shared dashboard state).

interface Props {
  channels: Array<{ id: string; label: string }>;
  onError: (message: string | null) => void;
}

const toneColor = { none: "inherit", ok: "#3fb950", warn: "#d29922", bad: "#ff5a1f" } as const;

export function WebhooksSection({ channels, onError }: Props) {
  const [list, setList] = useState<WebhookList | null>(null);
  const [url, setUrl] = useState("");
  const [label, setLabel] = useState("");
  const [pickedEvents, setPickedEvents] = useState<string[] | null>(null); // null = all
  const [pickedChannels, setPickedChannels] = useState<string[]>([]); // empty = all
  const [busy, setBusy] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, string>>({});
  const [openLog, setOpenLog] = useState<string | null>(null);
  const [log, setLog] = useState<WebhookDelivery[]>([]);

  const load = useCallback(async () => {
    try {
      setList(await api.listWebhooks());
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    }
  }, [onError]);

  useEffect(() => {
    void load();
  }, [load]);

  const available = list?.availableEvents ?? [];
  const atLimit = !!list && list.endpoints.length >= list.maxEndpoints;

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    onError(null);
    try {
      await action();
      await load();
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleAdd(e: FormEvent) {
    e.preventDefault();
    if (!url.trim()) return;
    await run(async () => {
      const created = await api.createWebhook({
        url: url.trim(),
        ...(label.trim() ? { label: label.trim() } : {}),
        events: pickedEvents ?? [],
        socialAccountIds: pickedChannels.length > 0 ? pickedChannels : null,
      });
      setSecret(created.secret);
      setUrl("");
      setLabel("");
      setPickedEvents(null);
      setPickedChannels([]);
    });
  }

  const toggleEvent = (event: string, on: boolean) =>
    setPickedEvents((prev) => {
      const current = prev ?? available;
      const next = on ? [...new Set([...current, event])] : current.filter((e) => e !== event);
      return next.length === available.length ? null : next;
    });

  async function handleTest(ep: WebhookEndpoint) {
    setBusy(true);
    try {
      const r = await api.testWebhook(ep.id);
      const text = r.delivered ? `Test delivered (${r.statusCode}).` : `Test failed${r.statusCode ? ` (${r.statusCode})` : ""}. ${r.error ?? ""}`.trim();
      setTestResults((prev) => ({ ...prev, [ep.id]: text }));
    } catch (err) {
      setTestResults((prev) => ({ ...prev, [ep.id]: err instanceof Error ? err.message : String(err) }));
    } finally {
      setBusy(false);
    }
  }

  async function toggleLog(ep: WebhookEndpoint) {
    if (openLog === ep.id) {
      setOpenLog(null);
      return;
    }
    try {
      setLog((await api.listWebhookDeliveries(ep.id)).deliveries);
      setOpenLog(ep.id);
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <section>
      <h2>Webhooks</h2>
      <p className="section-note">
        LazyRelay sends a signed HTTPS POST to each endpoint you add when something happens: a post is confirmed live, a post
        fails, a post is sent but can't be confirmed, or an account needs reconnecting. Use them with your own systems, or
        tools like Zapier, n8n or Make. If your endpoint is down, LazyRelay tries again up to 6 times over about 9 hours.
        Every delivery is signed with that endpoint's secret (HMAC-SHA256 of the body, in the X-LazyRelay-Signature header),
        and carries an X-LazyRelay-Delivery id that stays the same on retries so you can ignore a repeat.
      </p>

      {secret && (
        <div className="api-key-reveal" style={{ marginBottom: 12 }}>
          <p>
            <strong>Copy this secret now.</strong> It won't be shown again.
          </p>
          <CodeBlock code={secret} sensitive />
          <button type="button" className="btn-outline" onClick={() => setSecret(null)}>
            Done
          </button>
        </div>
      )}

      {list && list.endpoints.length === 0 && <p className="empty">No webhook endpoints yet.</p>}

      {list?.endpoints.map((ep) => {
        const health = describeLastDelivery(ep.lastDelivery);
        return (
          <div key={ep.id} className="account-list" style={{ marginBottom: 16, padding: 12, border: "1px solid rgba(255,255,255,0.12)", borderRadius: 10 }}>
            <div>
              <strong>{ep.label ?? "Endpoint"}</strong> {!ep.enabled && <em>(turned off)</em>}
            </div>
            <div style={{ wordBreak: "break-all" }}>{ep.url}</div>
            <div className="section-note">
              {describeEvents(ep.events, available)}. {describeChannels(ep.socialAccountIds, channels)}.
            </div>
            <div style={{ color: toneColor[health.tone] }}>{health.text}</div>
            {testResults[ep.id] && <div>{testResults[ep.id]}</div>}
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 8 }}>
              <button type="button" className="btn-outline" disabled={busy} onClick={() => void handleTest(ep)}>
                Send test
              </button>
              <button type="button" className="btn-outline" disabled={busy} onClick={() => void toggleLog(ep)}>
                {openLog === ep.id ? "Hide deliveries" : "Recent deliveries"}
              </button>
              <button type="button" className="btn-outline" disabled={busy} onClick={() => void run(() => api.updateWebhook(ep.id, { enabled: !ep.enabled }))}>
                {ep.enabled ? "Turn off" : "Turn on"}
              </button>
              <button
                type="button"
                className="btn-outline"
                disabled={busy}
                onClick={() => {
                  if (!window.confirm("Generate a new secret for this endpoint? The old one stops verifying immediately.")) return;
                  void run(async () => setSecret((await api.regenerateWebhookSecret(ep.id)).secret));
                }}
              >
                New secret
              </button>
              <button
                type="button"
                className="btn-outline"
                disabled={busy}
                onClick={() => {
                  if (!window.confirm("Remove this webhook endpoint? LazyRelay will stop sending it events.")) return;
                  void run(() => api.deleteWebhook(ep.id));
                }}
              >
                Remove
              </button>
            </div>
            {openLog === ep.id && (
              <ul style={{ marginTop: 8 }}>
                {log.length === 0 && <li>No deliveries yet.</li>}
                {log.map((d) => (
                  <li key={d.id}>
                    {eventLabel(d.event)}: {describeDelivery(d)} ({new Date(d.createdAt).toLocaleString()})
                  </li>
                ))}
              </ul>
            )}
          </div>
        );
      })}

      <form onSubmit={handleAdd} className="settings-form">
        <h3 style={{ margin: 0 }}>Add an endpoint</h3>
        <input
          type="url"
          placeholder="https://your-endpoint.example.com/webhook"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          maxLength={2000}
          disabled={atLimit}
          aria-label="Endpoint URL"
          style={{ width: "100%", boxSizing: "border-box" }}
        />
        <input type="text" placeholder="Name (optional)" value={label} onChange={(e) => setLabel(e.target.value)} maxLength={60} disabled={atLimit} aria-label="Name" style={{ width: "100%", boxSizing: "border-box" }} />
        <fieldset disabled={atLimit} style={{ border: "none", padding: 0, margin: 0 }}>
          <legend className="section-note">Send me</legend>
          {available.map((event) => (
            <label key={event} className="field-check">
              <input type="checkbox" checked={(pickedEvents ?? available).includes(event)} onChange={(e) => toggleEvent(event, e.target.checked)} />
              {eventLabel(event)}
            </label>
          ))}
        </fieldset>
        {channels.length > 1 && (
          <fieldset disabled={atLimit} style={{ border: "none", padding: 0, margin: 0 }}>
            <legend className="section-note">Only for these accounts (leave all unticked for every account)</legend>
            {channels.map((c) => (
              <label key={c.id} className="field-check">
                <input
                  type="checkbox"
                  checked={pickedChannels.includes(c.id)}
                  onChange={(e) => setPickedChannels((prev) => (e.target.checked ? [...prev, c.id] : prev.filter((id) => id !== c.id)))}
                />
                {c.label}
              </label>
            ))}
          </fieldset>
        )}
        <button type="submit" disabled={busy || atLimit || !url.trim() || (pickedEvents !== null && pickedEvents.length === 0)}>
          {busy ? "Saving..." : "Add endpoint"}
        </button>
        {atLimit && <p className="section-note">You can have up to {list?.maxEndpoints} endpoints. Remove one to add another.</p>}
      </form>
    </section>
  );
}
