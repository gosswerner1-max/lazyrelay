// Competitor mode: paste a competitor link or a YouTube link, confirm, and get a draft post to edit and save.
// One box, one Analyze button. The link is checked here first (closed networks are caught before anything is sent), then a
// consent dialog opens, and only a ticked box plus the confirm sends the request.

import { useId, useRef, useState, type FormEvent } from "react";
import { normalizeCompetitorInput, type CompetitorClient } from "../../lib/competitorMode";
import { CompetitorConsentDialog, type DialogOrigin } from "./CompetitorConsentDialog";
import { CompetitorResult, type DraftToSave } from "./CompetitorResult";
import { useCompetitorAnalysis } from "./useCompetitorAnalysis";
import "../../styles/competitor-mode.css";

interface Props {
  client: CompetitorClient;
  /** Saves the draft through the app's own draft call. It lands as a draft, never scheduled or posted. */
  onSaveDraft: (draft: DraftToSave) => Promise<void>;
}

export function CompetitorPanel({ client, onSaveDraft }: Props) {
  const uid = useId();
  const id = (part: string) => `${uid}-${part}`;
  const analyzeRef = useRef<HTMLButtonElement>(null);
  const [text, setText] = useState("");
  const [inputError, setInputError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null); // the checked link waiting for the consent dialog
  const [dialogOpen, setDialogOpen] = useState(false);
  const [origin, setOrigin] = useState<DialogOrigin | null>(null);
  const { state, start, cancel } = useCompetitorAnalysis(client);
  const running = state.kind === "running";

  function askFirst(e: FormEvent) {
    e.preventDefault();
    if (running) return;
    const check = normalizeCompetitorInput(text);
    if (!check.ok) {
      setInputError(check.error);
      return;
    }
    setInputError(null);
    const box = analyzeRef.current?.getBoundingClientRect();
    setOrigin(box ? { x: box.left + box.width / 2, y: box.top + box.height / 2 } : null);
    setPending(check.input);
    setDialogOpen(true);
  }

  function confirm() {
    setDialogOpen(false);
    if (pending) void start(pending);
  }

  return (
    <section className="cs-card cs-competitor" aria-labelledby={id("title")}>
      <h3 className="cs-card__title" id={id("title")}>
        Competitor analysis
      </h3>
      <p className="cs-note">Paste a link to a competitor's page or a YouTube video. We read it and write a draft post for you to edit. Nothing is posted until you approve it.</p>

      <form className="cs-competitor__form" onSubmit={askFirst} noValidate>
        <div className="cs-field">
          <label className="cs-label" htmlFor={id("link")}>
            Paste a competitor link or website
          </label>
          <input
            id={id("link")}
            className="cs-input"
            type="text"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            placeholder="https://"
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setInputError(null);
            }}
            aria-invalid={inputError ? true : undefined}
            aria-describedby={[id("hint"), inputError ? id("error") : null].filter(Boolean).join(" ")}
          />
          <p className="cs-hint" id={id("hint")}>
            Pages from their website and YouTube links work. Closed networks such as TikTok, Instagram, Facebook, X and LinkedIn do not.
          </p>
          {inputError && (
            <p className="cs-error" id={id("error")} role="alert">
              {inputError}
            </p>
          )}
        </div>
        <div className="cs-actions">
          <button ref={analyzeRef} type="submit" className="cs-btn cs-btn--primary" disabled={running}>
            Analyze
          </button>
        </div>
      </form>

      {running && (
        <div className="cs-progress">
          <p className="cs-result cs-result--info" role="status">
            Reading the page and writing a draft. This can take up to 90 seconds.
          </p>
          <button type="button" className="cs-btn cs-btn--secondary" onClick={cancel}>
            Cancel
          </button>
        </div>
      )}
      {state.kind === "error" && (
        <p className="cs-result cs-result--bad" role="alert">
          {state.message}
        </p>
      )}
      {state.kind === "done" && <CompetitorResult key={state.analysis.sourceUrl + state.analysis.draft.content} analysis={state.analysis} onSaveDraft={onSaveDraft} />}

      <CompetitorConsentDialog open={dialogOpen} link={pending ?? ""} origin={origin} restoreFocusTo={analyzeRef} onConfirm={confirm} onCancel={() => setDialogOpen(false)} />
    </section>
  );
}
