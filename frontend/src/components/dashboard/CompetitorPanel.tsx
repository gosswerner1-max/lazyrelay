// Competitor content blueprint: paste a competitor page link, confirm, and read how that page is built next to changes you
// could make to your own content. One box, one Analyze button. The link is checked here first (closed networks and video
// links are caught before anything is sent), then a
// consent dialog opens, and only a ticked box plus the confirm sends the request.

import { useEffect, useId, useRef, useState, type FormEvent, type RefObject } from "react";
import { normalizeCompetitorInput, type CompetitorClient } from "../../lib/competitorMode";
import type { BillingUi } from "../../lib/competitorBilling";
import { CompetitorConsentDialog, type DialogOrigin } from "./CompetitorConsentDialog";
import { BlueprintResult } from "./BlueprintResult";
import { useCompetitorAnalysis } from "./useCompetitorAnalysis";
import { GuidedTour } from "./GuidedTour";
import { frontDoorTourSteps, TOUR_TARGET } from "../../lib/frontDoorTour";
import "../../styles/competitor-mode.css";

interface Props {
  client: CompetitorClient;
  /** The credits the customer has, when the page shows a balance. It only feeds step 3 of the "Help me set up" tour. */
  creditBalance?: number;
  /** Set only when credits are switched on: makes the run key, and supplies the cost words. Absent, the panel behaves as it always did. */
  billing?: BillingUi;
  /** Opens the place to buy credits. The "Add credits" button shows only when this is given. */
  onAddCredits?: () => void;
  /** Called with the new balance once a paid blueprint is shown. */
  onBalanceChanged?: (balance: number) => void;
}

interface LinkFieldProps {
  id: string;
  value: string;
  error: string | null;
  onChange: (value: string) => void;
}

function LinkField({ id, value, error, onChange }: LinkFieldProps) {
  return (
    <div className="cs-field">
      <label className="cs-label" htmlFor={id}>
        Paste a competitor link or website
      </label>
      <input
        id={id}
        className="cs-input"
        type="text"
        data-tour={TOUR_TARGET.link}
        inputMode="url"
        autoComplete="off"
        spellCheck={false}
        placeholder="https://"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={error ? true : undefined}
        aria-describedby={[`${id}-hint`, error ? `${id}-error` : null].filter(Boolean).join(" ")}
      />
      <p className="cs-hint" id={`${id}-hint`}>
        Pages and posts from their website work. Closed networks such as TikTok, Instagram, Facebook, X and LinkedIn do not, and video links do not.
      </p>
      {error && (
        <p className="cs-error" id={`${id}-error`} role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function Progress({ onCancel }: { onCancel: () => void }) {
  return (
    <div className="cs-progress">
      <p className="cs-result cs-result--info" role="status">
        Reading the page and building your blueprint. This can take up to 90 seconds.
      </p>
      <button type="button" className="cs-btn cs-btn--secondary" onClick={onCancel}>
        Cancel
      </button>
    </div>
  );
}

/** The link box, its check, and the consent dialog that follows a good check. Nothing is sent from here. */
function useLinkEntry(analyzeRef: RefObject<HTMLButtonElement | null>) {
  const [text, setText] = useState("");
  const [inputError, setInputError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null); // the checked link waiting for the consent dialog
  const [dialogOpen, setDialogOpen] = useState(false);
  const [origin, setOrigin] = useState<DialogOrigin | null>(null);

  function submit(e: FormEvent) {
    e.preventDefault();
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

  function change(value: string) {
    setText(value);
    setInputError(null);
  }

  return { text, inputError, pending, dialogOpen, origin, submit, change, closeDialog: () => setDialogOpen(false) };
}

/** The one key of the run the person just confirmed: made at the confirmation, kept for its retries, dropped when the notice opens again. */
function useRunKey(billing: BillingUi | undefined) {
  const key = useRef<string | null>(null);
  return {
    forRun: () => (billing ? (key.current ??= billing.newKey()) : undefined),
    forget: () => {
      key.current = null;
    },
  };
}

export function CompetitorPanel({ client, creditBalance, billing, onAddCredits, onBalanceChanged }: Props) {
  const uid = useId();
  const id = (part: string) => `${uid}-${part}`;
  const analyzeRef = useRef<HTMLButtonElement>(null);
  const entry = useLinkEntry(analyzeRef);
  const { state, start, cancel } = useCompetitorAnalysis(client);
  const running = state.kind === "running";
  const runKey = useRunKey(billing);
  const balanceChanged = useRef(onBalanceChanged);
  balanceChanged.current = onBalanceChanged;

  useEffect(() => {
    if (state.kind === "done" && typeof state.result.balance === "number") balanceChanged.current?.(state.result.balance);
  }, [state]);

  function confirm() {
    entry.closeDialog();
    if (!entry.pending) return;
    const key = runKey.forRun();
    void (key === undefined ? start(entry.pending) : start(entry.pending, key));
  }

  const notices = billing ? [billing.costNotice, ...(typeof creditBalance === "number" ? [billing.balanceNotice(creditBalance)] : [])] : [];
  const needsCredits = billing && onAddCredits && state.kind === "error" && state.code === "insufficient_credits";

  return (
    <section className="cs-card cs-competitor" aria-labelledby={id("title")}>
      <h3 className="cs-card__title" id={id("title")}>
        Competitor content blueprint
      </h3>
      <p className="cs-note">Paste a link to a competitor's page or post. We read its public text and show you how it is built, next to changes you could make to your own content.</p>

      <form className="cs-competitor__form" onSubmit={(e) => {
          if (running) return e.preventDefault();
          runKey.forget();
          entry.submit(e);
        }} noValidate>
        <LinkField id={id("link")} value={entry.text} error={entry.inputError} onChange={entry.change} />
        <div className="cs-actions">
          <button ref={analyzeRef} type="submit" className="cs-btn cs-btn--primary" data-tour={TOUR_TARGET.analyze} aria-disabled={running ? true : undefined}>
            Analyze
          </button>
          <GuidedTour steps={frontDoorTourSteps(creditBalance)} buttonClassName="cs-btn cs-btn--secondary" />
        </div>
      </form>

      {running && <Progress onCancel={cancel} />}
      {state.kind === "error" && (
        <p className="cs-result cs-result--bad" role="alert">
          {state.message}
        </p>
      )}
      {needsCredits && (
        <button type="button" className="cs-btn cs-btn--primary" onClick={onAddCredits}>
          {billing.addCreditsLabel}
        </button>
      )}
      {state.kind === "done" && <BlueprintResult key={state.result.sourceUrl + state.result.title} result={state.result} />}

      <CompetitorConsentDialog open={entry.dialogOpen} link={entry.pending ?? ""} origin={entry.origin} restoreFocusTo={analyzeRef} notices={notices} onConfirm={confirm} onCancel={entry.closeDialog} />
    </section>
  );
}
