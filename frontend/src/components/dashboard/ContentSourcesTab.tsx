// The Content Sources tab: a form to add and check a source (RSS feed, sitemap or CSV file) and a table of the drafts those
// sources made, waiting for a person. A thin client. It reads nothing itself: the checking and the drafting happen in a
// separate service, reached only through the ContentSourcesClient (see lib/contentSources.ts). The three row actions are
// handed in as props, so each one runs through the dashboard's own existing post flows.

import { useId, useMemo, useState, type ChangeEvent, type FormEvent, type KeyboardEvent } from "react";
import type { Brand, ScheduledPost } from "../../lib/api";
import {
  CSV_MAX_BYTES,
  SOURCE_TYPES,
  SOURCE_TYPE_LABELS,
  URL_MAX_LENGTH,
  contentSourceDrafts,
  defaultContentSourcesClient,
  describeVerifyResult,
  validateCsvFile,
  validateSourceUrl,
  type ContentSourcesClient,
  type DraftRow,
  type SourceInput,
  type SourceType,
  type VerifyResult,
} from "../../lib/contentSources";
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
  client?: ContentSourcesClient;
}

const STATUS_BADGE = "Generated draft, pending review";
const EMPTY_TEXT = "Add an RSS feed, your own sitemap or a CSV file, then drafts appear here for your review.";
const CSV_MAX_MB = CSV_MAX_BYTES / (1024 * 1024);

export function ContentSourcesTab({ posts, brands, onReviewAndEdit, onApproveToCalendar, onPurge, client = defaultContentSourcesClient }: ContentSourcesTabProps) {
  const uid = useId();
  const id = (part: string) => `${uid}-${part}`;

  const [type, setType] = useState<SourceType>("rss");
  const [urlText, setUrlText] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [brandId, setBrandId] = useState("");
  const [verifying, setVerifying] = useState(false);
  const [result, setResult] = useState<VerifyResult | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const isCsv = type === "csv";
  const urlCheck = isCsv ? null : validateSourceUrl(urlText);
  const urlError = urlCheck && !urlCheck.ok && urlText.trim() !== "" ? urlCheck.error : null;
  const fileCheck = file ? validateCsvFile(file) : null;
  const fileError = fileCheck && !fileCheck.ok ? fileCheck.error : null;
  const inputValid = isCsv ? fileCheck?.ok === true : urlCheck?.ok === true;

  const rows = useMemo(() => contentSourceDrafts(posts), [posts]);

  function changeType(next: SourceType) {
    setType(next);
    setResult(null);
    if (next !== "csv") setFile(null); // the file picker is gone, so its file goes too
  }

  function onUrlChange(e: ChangeEvent<HTMLInputElement>) {
    setUrlText(e.target.value);
    setResult(null);
  }

  function onFileChange(e: ChangeEvent<HTMLInputElement>) {
    setFile(e.target.files?.[0] ?? null);
    setResult(null);
  }

  function buildInput(): SourceInput | null {
    const brand = brandId || null;
    if (isCsv) return file && fileCheck?.ok ? { type: "csv", file, brandId: brand } : null;
    return urlCheck?.ok ? { type, url: urlCheck.url, brandId: brand } : null;
  }

  async function verify() {
    const input = buildInput();
    if (!input) return;
    setVerifying(true);
    setResult(null);
    try {
      setResult(await client.verifySource(input));
    } catch (err) {
      console.error(err);
      setResult({ status: "failed", reason: "Something went wrong while checking. Try again in a moment." });
    } finally {
      setVerifying(false);
    }
  }

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

  const urlLabel = type === "sitemap" ? "Sitemap address" : "Feed address";
  const urlHint = type === "sitemap" ? "The public https address of your sitemap file." : "The public https address of your feed.";
  const statusText = verifying ? "Checking this source..." : result ? describeVerifyResult(result) : "";
  const statusTone = result?.status === "verified" ? "ok" : result?.status === "failed" ? "bad" : "info";

  return (
    <section className="byok-panels content-sources" aria-labelledby={id("title")}>
      <header className="cs-head">
        <h2 id={id("title")}>Content Sources</h2>
        <p>Add an RSS feed, a sitemap or a CSV file. Drafts made from it wait below for your review. Nothing is posted until you approve it.</p>
      </header>

      <form className="cs-card" onSubmit={(e: FormEvent) => e.preventDefault()} noValidate>
        <h3 className="cs-card__title">Add a source</h3>
        <div className="cs-fields">
          <div className="cs-field cs-field--wide">
            <span className="cs-label" id={id("type-label")}>
              Source type
            </span>
            <div className="cs-segments" role="radiogroup" aria-labelledby={id("type-label")}>
              {SOURCE_TYPES.map((t) => (
                <label key={t} className="cs-segment">
                  <input type="radio" name={id("type")} value={t} checked={type === t} onChange={() => changeType(t)} />
                  <span className="cs-segment__label">{SOURCE_TYPE_LABELS[t]}</span>
                </label>
              ))}
            </div>
          </div>

          {isCsv ? (
            <div className="cs-field">
              <label className="cs-label" htmlFor={id("file")}>
                CSV file
              </label>
              <input
                id={id("file")}
                className="cs-input"
                type="file"
                accept=".csv,text/csv"
                onChange={onFileChange}
                aria-invalid={fileError ? true : undefined}
                aria-describedby={[id("file-hint"), fileError ? id("file-error") : null].filter(Boolean).join(" ")}
              />
              <p className="cs-hint" id={id("file-hint")}>
                Choose a .csv file, up to {CSV_MAX_MB} MB.
              </p>
              {fileError && (
                <p className="cs-error" id={id("file-error")}>
                  {fileError}
                </p>
              )}
            </div>
          ) : (
            <div className="cs-field">
              <label className="cs-label" htmlFor={id("url")}>
                {urlLabel}
              </label>
              <input
                id={id("url")}
                className="cs-input"
                type="url"
                inputMode="url"
                autoComplete="off"
                spellCheck={false}
                maxLength={URL_MAX_LENGTH}
                placeholder="https://"
                value={urlText}
                onChange={onUrlChange}
                aria-invalid={urlError ? true : undefined}
                aria-describedby={[id("url-hint"), urlError ? id("url-error") : null].filter(Boolean).join(" ")}
              />
              <p className="cs-hint" id={id("url-hint")}>
                {urlHint}
              </p>
              {urlError && (
                <p className="cs-error" id={id("url-error")}>
                  {urlError}
                </p>
              )}
            </div>
          )}

          <div className="cs-field">
            <label className="cs-label" htmlFor={id("brand")}>
              Target brand
            </label>
            <select id={id("brand")} className="cs-input" value={brandId} onChange={(e) => setBrandId(e.target.value)}>
              <option value="">No brand</option>
              {brands.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="cs-actions">
          <button type="button" className="cs-btn cs-btn--primary" disabled={!inputValid || verifying} onClick={verify}>
            Verify Source Integrity
          </button>
          <p className={`cs-result cs-result--${statusTone}`} role="status">
            {statusText}
          </p>
        </div>
      </form>

      <section className="cs-card" aria-labelledby={id("drafts-title")}>
        <h3 className="cs-card__title" id={id("drafts-title")}>
          Drafts for review
        </h3>
        {rows.length === 0 ? (
          <p className="cs-empty">{EMPTY_TEXT}</p>
        ) : (
          <div className="cs-table-wrap" role="region" aria-label="Drafts from your content sources" tabIndex={0}>
            <table className="cs-table">
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
