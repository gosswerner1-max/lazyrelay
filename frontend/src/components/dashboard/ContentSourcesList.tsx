// "Your sources": one row per source the customer has added, with its status, when it last ran, its last problem in plain
// words, and the three things they can do: Check now (the website proof), Run now, and Remove.

import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { SOURCE_TYPE_LABELS, describeLastProblem, type ServiceSource } from "../../lib/contentSources";
import { Message } from "./ContentSourcesParts";
import type { Msg } from "./useContentSources";

interface Props {
  sources: ServiceSource[];
  busy: string | null;
  message: Msg | null;
  /** Shown above the table: the answer to a Check now that has no proof panel open. */
  children?: ReactNode;
  /** The source whose proof panel is open, if any (it does not need the "closed the steps" hint). */
  proofOpenFor: string | null;
  onCheck: (id: string) => void;
  onRun: (id: string) => void;
  onRemove: (id: string) => Promise<boolean>;
}

const WHEN = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

function formatWhen(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "Unknown" : WHEN.format(date);
}

type Status = { label: string; tone: "wait" | "ok" | "attention" };

function statusOf(s: ServiceSource): Status {
  if (!s.domainVerified) return { label: "Waiting for proof", tone: "wait" };
  if (s.lastError !== null || s.consecutiveFailures > 0) return { label: "Needs attention", tone: "attention" };
  return { label: "Verified", tone: "ok" };
}

export function ContentSourcesList({ sources, busy, message, children, proofOpenFor, onCheck, onRun, onRemove }: Props) {
  const uid = useId();
  const id = (part: string) => `${uid}-${part}`;
  const heading = useRef<HTMLHeadingElement>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);

  function closeConfirm(rowId: string) {
    setConfirmId(null);
    document.getElementById(id(`remove-${rowId}`))?.focus();
  }

  function onConfirmKeyDown(e: KeyboardEvent<HTMLDivElement>, rowId: string) {
    if (e.key === "Escape") {
      e.stopPropagation();
      closeConfirm(rowId);
    }
  }

  async function confirmRemove(rowId: string) {
    setConfirmId(null);
    if (await onRemove(rowId)) heading.current?.focus(); // the row is gone, so focus goes to the start of the list
  }

  const anyBusy = busy !== null;

  return (
    <section className="cs-card" aria-labelledby={id("title")}>
      <h3 className="cs-card__title" id={id("title")} tabIndex={-1} ref={heading}>
        Your sources
      </h3>
      <Message msg={message} />
      {children}
      {sources.length === 0 ? (
        <p className="cs-empty">No sources yet. Add one above, then prove you own the website.</p>
      ) : (
        <div className="cs-table-wrap" role="region" aria-label="Your content sources" tabIndex={0}>
          <table className="cs-table" aria-label="Your content sources">
            <thead>
              <tr>
                <th scope="col">Address</th>
                <th scope="col">Type</th>
                <th scope="col">Status</th>
                <th scope="col">Last synced</th>
                <th scope="col">Last problem</th>
                <th scope="col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {sources.map((s) => {
                const status = statusOf(s);
                const addressId = id(`address-${s.id}`);
                const problem = describeLastProblem(s.lastError);
                return (
                  <tr key={s.id}>
                    <th scope="row" id={addressId}>
                      {s.sourceUrl ?? "CSV file"}
                    </th>
                    <td>{SOURCE_TYPE_LABELS[s.sourceType]}</td>
                    <td>
                      <span className={`cs-badge cs-badge--${status.tone}`}>{status.label}</span>
                      {!s.domainVerified && proofOpenFor !== s.id && (
                        <p className="cs-hint">Use Check now once you have published a proof. If you closed the steps, remove this source and add it again to see them.</p>
                      )}
                    </td>
                    <td>{s.lastSyncedAt ? <time dateTime={s.lastSyncedAt}>{formatWhen(s.lastSyncedAt)}</time> : "Not yet"}</td>
                    <td>{problem || "None"}</td>
                    <td>
                      <div className="cs-row-actions">
                        <button type="button" className="cs-btn cs-btn--secondary" disabled={anyBusy} aria-describedby={addressId} onClick={() => onCheck(s.id)}>
                          Check now
                        </button>
                        <button type="button" className="cs-btn cs-btn--primary" disabled={anyBusy} aria-describedby={addressId} onClick={() => onRun(s.id)}>
                          Run now
                        </button>
                        <button type="button" id={id(`remove-${s.id}`)} className="cs-btn cs-btn--quiet" disabled={anyBusy} aria-describedby={addressId} onClick={() => setConfirmId(s.id)}>
                          Remove
                        </button>
                        {confirmId === s.id && (
                          <div className="cs-confirm" role="group" aria-label="Confirm remove" onKeyDown={(e) => onConfirmKeyDown(e, s.id)}>
                            <p className="cs-confirm__text">Remove this source? It will stop making new drafts.</p>
                            {sources.length === 1 && <p className="cs-hint">This is your last source, so your saved key is removed too.</p>}
                            <div className="cs-row-actions">
                              <button type="button" className="cs-btn cs-btn--secondary" autoFocus onClick={() => closeConfirm(s.id)}>
                                Keep source
                              </button>
                              <button type="button" className="cs-btn cs-btn--primary" onClick={() => void confirmRemove(s.id)}>
                                Remove source
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
