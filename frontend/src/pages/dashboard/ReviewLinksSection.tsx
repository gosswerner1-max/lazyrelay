import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api } from "../../lib/api";
import { describeLink, reviewUrl, type ReviewLinkList } from "../../lib/reviewLinks";

// Settings > Client review links: send a client a link where, without an account, they see the
// posts waiting for their approval, approve them, ask for changes and comment. Self-contained.

interface Props {
  brands: string[];
  onError: (message: string | null) => void;
}

export function ReviewLinksSection({ brands, onError }: Props) {
  const [list, setList] = useState<ReviewLinkList | null>(null);
  const [label, setLabel] = useState("");
  const [brand, setBrand] = useState("");
  const [days, setDays] = useState(30);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [showRemoved, setShowRemoved] = useState(false);

  const load = useCallback(async () => {
    try {
      setList(await api.listReviewLinks());
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    }
  }, [onError]);

  useEffect(() => {
    void load();
  }, [load]);

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

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    await run(async () => {
      await api.createReviewLink({ ...(label.trim() ? { label: label.trim() } : {}), ...(brand ? { brandLabel: brand } : {}), expiresInDays: days });
      setLabel("");
    });
  }

  async function copy(token: string) {
    try {
      await navigator.clipboard.writeText(reviewUrl(token, window.location.origin));
      setCopied(token);
    } catch {
      window.prompt("Copy this link:", reviewUrl(token, window.location.origin));
    }
  }

  const removedCount = list?.links.filter((l) => l.status !== "active").length ?? 0;
  const visibleLinks = list?.links.filter((l) => showRemoved || l.status === "active") ?? [];
  const noPlan = !!list && list.maxLinks === 0;
  const activeCount = list?.links.filter((l) => l.status === "active").length ?? 0;
  const atLimit = !!list && list.maxLinks > 0 && activeCount >= list.maxLinks;

  return (
    <section>
      <h2>Client review links</h2>
      <p className="section-note">
        Send a client a link where they can see the posts waiting for their approval, approve them, ask for changes and leave comments. They do not need an account. To use it, tick "Require approval before this goes out" when you
        schedule a post, then send the link. You get an email when they approve or ask for changes.
      </p>

      {noPlan && (
        <p className="section-note">
          <strong>Client review links are part of the Starter plan and above.</strong> Upgrade to send a link to your clients.
        </p>
      )}
      {list && !noPlan && (
        <p className="section-note">
          Your plan includes {list.maxLinks} active link{list.maxLinks === 1 ? "" : "s"}. You have {activeCount}.
        </p>
      )}
      {list && activeCount === 0 && !noPlan && <p className="empty">No active review links.</p>}

      {visibleLinks.map((l) => (
        <div key={l.id} className="link-row">
          <strong>{l.label || "Review link"}</strong> {l.brandLabel && <span className="coming-soon-badge">{l.brandLabel}</span>}
          <div style={{ fontSize: 14 }}>{describeLink(l)}</div>
          {l.status === "active" && (
            <div style={{ display: "flex", gap: 8, marginTop: 6, flexWrap: "wrap" }}>
              <button type="button" className="btn-outline" onClick={() => copy(l.token)}>
                {copied === l.token ? "Link copied" : "Copy link"}
              </button>
              <button type="button" className="btn-outline" disabled={busy} onClick={() => window.confirm("Stop this link working? Your client will no longer be able to open it.") && run(() => api.revokeReviewLink(l.id))}>
                Stop this link
              </button>
            </div>
          )}
        </div>
      ))}

      {removedCount > 0 && (
        <button type="button" className="btn-outline" style={{ marginBottom: 12 }} onClick={() => setShowRemoved(!showRemoved)}>
          {showRemoved ? "Hide old links" : `Show ${removedCount} old link${removedCount === 1 ? "" : "s"} (expired or removed)`}
        </button>
      )}

      {!noPlan && (
        <form onSubmit={handleCreate} className="settings-form">
          <input type="text" placeholder="Who is it for? (optional, for example Acme)" maxLength={60} value={label} onChange={(e) => setLabel(e.target.value)} />
          {brands.length > 0 && (
            <label>
              Only show posts for one brand (optional)
              <select value={brand} onChange={(e) => setBrand(e.target.value)}>
                <option value="">All brands</option>
                {brands.map((b) => (
                  <option key={b} value={b}>
                    {b}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label>
            The link stops working after
            <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
              {[7, 14, 30, 60, 90].map((d) => (
                <option key={d} value={d}>
                  {d} days
                </option>
              ))}
            </select>
          </label>
          <button type="submit" className="btn-primary" disabled={busy || atLimit}>
            {atLimit ? "Link limit reached" : "Create review link"}
          </button>
        </form>
      )}
    </section>
  );
}
