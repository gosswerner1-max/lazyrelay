// The Content Sources tab: the customer connects their own LazyRelay key, adds an RSS feed or a sitemap from their own website,
// proves the website is theirs, and then sees the drafts those sources made, waiting for a person. A thin client. It reads
// nothing itself: the checking and the drafting happen in the companion service, reached only through the ContentSourcesClient
// (see lib/contentSources.ts). The three draft actions are handed in as props, so each one runs through the dashboard's own
// existing post flows.

import { useId, useMemo, useState, type KeyboardEvent } from "react";
import type { Brand, ScheduledPost } from "../../lib/api";
import { SOURCE_TYPE_LABELS, contentSourceDrafts, type ContentSourcesClient, type DraftRow } from "../../lib/contentSources";
import { ContentSourcesAddForm } from "./ContentSourcesAddForm";
import { ContentSourcesKey } from "./ContentSourcesKey";
import { ContentSourcesList } from "./ContentSourcesList";
import { CheckResult, ContentSourcesProof } from "./ContentSourcesProof";
import { useContentSources } from "./useContentSources";
import "../../styles/byok-panels.css";
import "../../styles/content-sources.css";

type RowHandler = (post: ScheduledPost) => void | Promise<void>;

export interface ContentSourcesTabProps {
  /** All the account's posts. Only the drafts a content source made are shown. */
  posts: ScheduledPost[];
  /** The account's brands, for the Target brand list. */
  brands: Brand[];
  onReviewAndEdit: RowHandler;
  onApproveToCalendar: RowHandler;
  onPurge: RowHandler;
  /** The companion service. The dashboard hands in the real one; tests hand in a mock. */
  client: ContentSourcesClient;
  /** Takes the customer to the API Keys tab, where they make the key. */
  onOpenApiKeys?: () => void;
  /** Takes the customer to the plan page the app already has. */
  onOpenPlan?: () => void;
}

const STATUS_BADGE = "Generated draft, pending review";
const EMPTY_TEXT = "Add an RSS feed or your own sitemap, then drafts appear here for your review.";

const BLOCKED_TITLES: Partial<Record<string, string>> = {
  not_connected: "Not connected yet",
  sign_in: "Please sign in again",
  unauthorized: "Please sign in again",
};
const NO_RETRY = new Set(["not_connected", "sign_in", "unauthorized"]);

export function ContentSourcesTab({ posts, brands, onReviewAndEdit, onApproveToCalendar, onPurge, client, onOpenApiKeys, onOpenPlan }: ContentSourcesTabProps) {
  const uid = useId();
  const id = (part: string) => `${uid}-${part}`;
  const cs = useContentSources(client);

  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const rows = useMemo(() => contentSourceDrafts(posts), [posts]);

  async function runRow(row: DraftRow, handler: RowHandler) {
    setBusyId(row.id);
    try {
      await handler(row.post);
    } finally {
      setBusyId(null);
    }
  }

  function closeConfirm(rowId: string) {
    setConfirmId(null);
    document.getElementById(id(`purge-${rowId}`))?.focus();
  }

  function onConfirmKeyDown(e: KeyboardEvent<HTMLDivElement>, rowId: string) {
    if (e.key === "Escape") {
      e.stopPropagation();
      closeConfirm(rowId);
    }
  }

  const checkingId = cs.busy?.startsWith("check:") ? cs.busy.slice("check:".length) : null;
  const activeCheckId = cs.check?.sourceId ?? checkingId;
  const proofSource = cs.proof ? cs.sources.find((s) => s.id === cs.proof!.sourceId) : undefined;
  // The answer to a check shows inside the proof panel when that panel is open for the source, and under the list title otherwise.
  const checkInPanel = proofSource !== undefined && activeCheckId === proofSource.id;
  const checkInList = activeCheckId !== null && !checkInPanel;

  return (
    <section className="byok-panels content-sources" aria-labelledby={id("title")}>
      <header className="cs-head">
        <h2 id={id("title")}>Content Sources</h2>
        <p>Add an RSS feed or a sitemap. Drafts made from it wait below for your review. Nothing is posted until you approve it.</p>
      </header>

      {cs.phase.kind === "loading" && (
        <p className="cs-empty" role="status">
          Loading your sources...
        </p>
      )}

      {cs.phase.kind === "blocked" && (
        <section className="cs-card" aria-labelledby={id("blocked-title")}>
          <h3 className="cs-card__title" id={id("blocked-title")}>
            {BLOCKED_TITLES[cs.phase.error.code] ?? "Could not load Content Sources"}
          </h3>
          <p className="cs-result cs-result--info" role="status">
            {cs.phase.error.message}
          </p>
          {!NO_RETRY.has(cs.phase.error.code) && (
            <div className="cs-actions">
              <button type="button" className="cs-btn cs-btn--secondary" onClick={() => void cs.retry()}>
                Try again
              </button>
            </div>
          )}
        </section>
      )}

      {cs.phase.kind === "ready" && (
        <>
          <ContentSourcesKey
            credential={cs.credential}
            busy={cs.busy === "key"}
            message={cs.keyMsg}
            onSave={cs.saveKey}
            onRemove={cs.removeKey}
            onOpenApiKeys={onOpenApiKeys}
          />
          <ContentSourcesAddForm brands={brands} busy={cs.busy === "add"} message={cs.formMsg} onAdd={cs.addSource} onOpenPlan={onOpenPlan} />
          {cs.proof && proofSource && (
            <ContentSourcesProof
              key={cs.proof.sourceId}
              source={proofSource}
              verification={cs.proof.verification}
              busy={cs.busy !== null}
              check={checkInPanel ? cs.check : null}
              checking={checkingId === proofSource.id}
              onCheck={() => void cs.checkSource(proofSource.id)}
              onClose={cs.closeProof}
            />
          )}
          <ContentSourcesList
            sources={cs.sources}
            busy={cs.busy}
            message={cs.listMsg}
            proofOpenFor={cs.proof?.sourceId ?? null}
            onCheck={(sourceId) => void cs.checkSource(sourceId)}
            onRun={(sourceId) => void cs.runSource(sourceId)}
            onRemove={cs.removeSource}
          >
            {checkInList && <CheckResult check={cs.check} checking={checkingId !== null} />}
          </ContentSourcesList>
        </>
      )}

      <section className="cs-card" aria-labelledby={id("drafts-title")}>
        <h3 className="cs-card__title" id={id("drafts-title")}>
          Drafts for review
        </h3>
        {rows.length === 0 ? (
          <p className="cs-empty">{EMPTY_TEXT}</p>
        ) : (
          <div className="cs-table-wrap" role="region" aria-label="Drafts from your content sources" tabIndex={0}>
            <table className="cs-table" aria-label="Drafts from your content sources">
              <thead>
                <tr>
                  <th scope="col">Source</th>
                  <th scope="col">Title</th>
                  <th scope="col">Status</th>
                  <th scope="col">Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const busy = busyId === row.id;
                  return (
                    <tr key={row.id}>
                      <td>
                        <div className="cs-origin">
                          <span className="cs-chip">{row.origin.type ? SOURCE_TYPE_LABELS[row.origin.type] : "Content source"}</span>
                          {row.origin.name && <span>{row.origin.name}</span>}
                        </div>
                      </td>
                      <th scope="row">{row.title}</th>
                      <td>
                        <span className="cs-badge">{STATUS_BADGE}</span>
                      </td>
                      <td>
                        <div className="cs-row-actions">
                          <button type="button" className="cs-btn cs-btn--secondary" disabled={busy} onClick={() => runRow(row, onReviewAndEdit)}>
                            Review and edit
                          </button>
                          <button type="button" className="cs-btn cs-btn--primary" disabled={busy} onClick={() => runRow(row, onApproveToCalendar)}>
                            Approve and move to Calendar
                          </button>
                          <button type="button" id={id(`purge-${row.id}`)} className="cs-btn cs-btn--quiet" disabled={busy} onClick={() => setConfirmId(row.id)}>
                            Dismiss / purge
                          </button>
                          {confirmId === row.id && (
                            <div className="cs-confirm" role="group" aria-label="Confirm delete" onKeyDown={(e) => onConfirmKeyDown(e, row.id)}>
                              <p className="cs-confirm__text">Delete this draft permanently?</p>
                              <div className="cs-row-actions">
                                <button type="button" className="cs-btn cs-btn--secondary" autoFocus onClick={() => closeConfirm(row.id)}>
                                  Keep draft
                                </button>
                                <button
                                  type="button"
                                  className="cs-btn cs-btn--primary"
                                  onClick={() => {
                                    setConfirmId(null);
                                    void runRow(row, onPurge);
                                  }}
                                >
                                  Delete draft
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
    </section>
  );
}

export default ContentSourcesTab;
