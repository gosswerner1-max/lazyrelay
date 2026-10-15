import { useCallback, useEffect, useId, useState, type FormEvent } from "react";
import { api, type WhatsAppContact, type WhatsAppOptOutsResult } from "../../lib/api";
import { safeDisplay, safeName } from "../../lib/whatsappThreads";
import "../../styles/byok-panels.css";
import "../../styles/whatsapp-contacts.css";

// The contacts stored for one WhatsApp connection, and the list of numbers that opted out. A number is never shown, only the
// mask the server sends (and even a mask or name that looks like a long number is replaced, see lib/whatsappThreads.ts).
// Opting a contact out is permanent: the number is blocked, and a later import cannot add it again.

const PAGE = 50;
const errText = (err: unknown) => (err instanceof Error && err.message ? err.message : "Something went wrong. Please try again.");
const day = (iso: string | null) => {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString(undefined, { dateStyle: "medium" });
};

type StatusFilter = "" | "opted_in" | "opted_out";

interface ListProps {
  socialAccountId: string;
  /** Change this to reload the list (after an add or an import). */
  refreshKey: number;
  /** Called after an opt-out or an erase, so the opt-out list can reload. */
  onChanged?: () => void;
}

export function WhatsAppContactList({ socialAccountId, refreshKey, onChanged }: ListProps) {
  const id = useId();
  const [status, setStatus] = useState<StatusFilter>("");
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [searchError, setSearchError] = useState("");
  const [items, setItems] = useState<WhatsAppContact[]>([]);
  const [nextBefore, setNextBefore] = useState<string | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");
  const [moreBusy, setMoreBusy] = useState(false);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [rowBusy, setRowBusy] = useState<string | null>(null);

  const query = useCallback(
    (before?: string) => api.listWhatsAppContacts({ socialAccountId, status: status || undefined, search: search || undefined, before, limit: PAGE }),
    [socialAccountId, status, search],
  );

  useEffect(() => {
    let cancelled = false;
    query()
      .then((page) => {
        if (cancelled) return;
        setItems(page.contacts);
        setNextBefore(page.nextBefore);
        setError("");
        setState("ready");
      })
      .catch((err) => {
        if (cancelled) return;
        setError(errText(err));
        setState("error");
      });
    return () => {
      cancelled = true;
    };
  }, [query, refreshKey]);

  function submitSearch(e: FormEvent) {
    e.preventDefault();
    const term = searchInput.trim();
    // A phone number must never end up in a URL: the server refuses it too, this just says so first.
    if (term.replace(/\D/g, "").length >= 7) {
      setSearchError("Search by name or the last digits shown, not a full phone number.");
      return;
    }
    setSearchError("");
    setSearch(term);
  }

  async function loadMore() {
    if (!nextBefore || moreBusy) return;
    setMoreBusy(true);
    try {
      const page = await query(nextBefore);
      setItems((cur) => [...cur, ...page.contacts.filter((c) => !cur.some((x) => x.id === c.id))]);
      setNextBefore(page.nextBefore);
    } catch (err) {
      setError(errText(err));
    } finally {
      setMoreBusy(false);
    }
  }

  async function optOut(c: WhatsAppContact) {
    setRowBusy(c.id);
    setError("");
    try {
      await api.optOutWhatsAppContact(c.id);
      const when = new Date().toISOString();
      setItems((cur) => cur.map((x) => (x.id === c.id ? { ...x, consentStatus: "opted_out", optedOutAt: when } : x)));
      onChanged?.();
    } catch (err) {
      setError(errText(err));
    } finally {
      setRowBusy(null);
    }
  }

  async function erase(c: WhatsAppContact) {
    setRowBusy(c.id);
    setError("");
    try {
      await api.eraseWhatsAppContact(c.id);
      setItems((cur) => cur.filter((x) => x.id !== c.id));
      setConfirmId(null);
      onChanged?.();
    } catch (err) {
      setError(errText(err));
    } finally {
      setRowBusy(null);
    }
  }

  return (
    <section className="byok-card wac-card" aria-labelledby={`${id}-title`}>
      <h3 id={`${id}-title`} className="wac-title">
        Your contacts
      </h3>
      <div className="wac-toolbar">
        <label className="byok-field wac-field">
          Show
          <select value={status} onChange={(e) => setStatus(e.target.value as StatusFilter)}>
            <option value="">Everyone</option>
            <option value="opted_in">Opted in only</option>
            <option value="opted_out">Opted out only</option>
          </select>
        </label>
        <form className="wac-search" onSubmit={submitSearch} role="search">
          <label className="byok-field wac-field">
            Search
            <input type="search" placeholder="Name or last digits" value={searchInput} onChange={(e) => setSearchInput(e.target.value)} maxLength={40} />
          </label>
          <div className="byok-actions">
            <button type="submit" className="byok-secondary">
              Search
            </button>
          </div>
        </form>
      </div>
      {searchError && (
        <p className="byok-error" role="alert">
          {searchError}
        </p>
      )}
      {error && <p className="byok-error">{error}</p>}
      {state === "loading" && <p className="byok-card__hint">Loading contacts...</p>}
      {state === "ready" && items.length === 0 && <p className="byok-card__hint">No contacts yet. Add one above or import a CSV.</p>}
      {items.length > 0 && (
        <ul className="byok-conns wac-list ph-no-capture ph-mask">
          {items.map((c) => {
            const name = safeName(c.displayName);
            const label = name ?? safeDisplay(c.contactDisplay);
            const optedOut = c.consentStatus === "opted_out";
            return (
              <li key={c.id}>
                <div className="wac-who">
                  <span className="byok-conns__name">{name ?? "No name"}</span>
                  <span>{safeDisplay(c.contactDisplay)}</span>
                </div>
                <div className="wac-meta">
                  <span className={`byok-chip ${optedOut ? "byok-chip--off" : "byok-chip--ok"}`}>{optedOut ? "Opted out" : "Opted in"}</span>
                  <span className="byok-card__hint">{optedOut ? `Opted out ${day(c.optedOutAt)}` : `Consent given ${day(c.optedInAt)}`}</span>
                </div>
                <div className="byok-actions">
                  {!optedOut && (
                    <button type="button" className="byok-secondary" disabled={rowBusy === c.id} aria-label={`Mark ${label} as opted out`} onClick={() => void optOut(c)}>
                      Mark as opted out
                    </button>
                  )}
                  {confirmId === c.id ? (
                    <div role="group" aria-label="Confirm erase" className="wac-confirm">
                      <span>Erase this contact and its consent records? Their opt-out stays on file if they opted out.</span>
                      <button type="button" className="byok-primary" disabled={rowBusy === c.id} onClick={() => void erase(c)}>
                        Erase
                      </button>
                      <button type="button" className="byok-secondary" onClick={() => setConfirmId(null)}>
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <button type="button" className="byok-secondary" aria-label={`Erase ${label}`} onClick={() => setConfirmId(c.id)}>
                      Erase
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {nextBefore && (
        <div className="byok-actions">
          <button type="button" className="byok-secondary" disabled={moreBusy} onClick={() => void loadMore()}>
            {moreBusy ? "Loading..." : "Load more"}
          </button>
        </div>
      )}
    </section>
  );
}

export function WhatsAppOptOuts({ refreshKey }: { refreshKey: number }) {
  const id = useId();
  const [data, setData] = useState<WhatsAppOptOutsResult | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    api
      .listWhatsAppOptOuts()
      .then((r) => {
        if (!cancelled) {
          setData(r);
          setError("");
        }
      })
      .catch((err) => {
        if (!cancelled) setError(errText(err));
      });
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  return (
    <section className="byok-card wac-card" aria-labelledby={`${id}-title`}>
      <h3 id={`${id}-title`} className="wac-title">
        Opted-out numbers
      </h3>
      <p className="byok-card__hint">These numbers are blocked automatically, even if they appear in a later import. Only a masked version is kept.</p>
      {error && <p className="byok-error">{error}</p>}
      {data && (
        <>
          <p>{data.count === 1 ? "1 number has opted out." : `${data.count} numbers have opted out.`}</p>
          {data.optOuts.length > 0 && (
            <ul className="byok-conns ph-no-capture ph-mask">
              {data.optOuts.map((o) => (
                <li key={o.id}>
                  <span className="byok-conns__name">{safeDisplay(o.contactDisplay)}</span>
                  <span className="byok-card__hint">
                    {o.source === "keyword" ? "Replied STOP" : o.source === "manual" ? "Opted out by you" : o.source === "meta_131050" ? "Opted out through WhatsApp" : "From an import"} {day(o.occurredAt)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
