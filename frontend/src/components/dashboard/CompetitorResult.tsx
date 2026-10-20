// The answer to one analysis: the title, the source link, what the page said, and the draft in a box the customer can edit.
// Save as draft keeps it as a draft only. Nothing here schedules or posts anything.

import { useId, useState } from "react";
import { MAX_DRAFT_LENGTH, competitorDraftTags, type CompetitorAnalysis } from "../../lib/competitorMode";

export interface DraftToSave {
  content: string;
  tags: string[];
}

interface Props {
  analysis: CompetitorAnalysis;
  onSaveDraft: (draft: DraftToSave) => Promise<void>;
}

type SaveState = "idle" | "saving" | "saved" | "failed";

/** Only a plain web link is ever made clickable. Anything else is shown as text. */
function webLink(raw: string): URL | null {
  try {
    const url = new URL(raw);
    return url.protocol === "https:" || url.protocol === "http:" ? url : null;
  } catch {
    return null;
  }
}

function SourceHeader({ analysis }: { analysis: CompetitorAnalysis }) {
  const link = webLink(analysis.sourceUrl);
  return (
    <div className="cs-source">
      <span className="cs-chip">{analysis.kind === "youtube" ? "YouTube video" : "Web page"}</span>
      <h4 className="cs-source__title">{analysis.title}</h4>
      {link ? (
        <a className="cs-btn--link" href={link.href} target="_blank" rel="noopener noreferrer nofollow">
          {`${link.host}${link.pathname === "/" ? "" : link.pathname}`}
        </a>
      ) : (
        <span className="cs-hint">{analysis.sourceUrl}</span>
      )}
    </div>
  );
}

function Facts({ facts }: { facts: string[] }) {
  if (facts.length === 0) return null;
  return (
    <div>
      <p className="cs-label">What the page said</p>
      <ul className="cs-reasons">
        {facts.map((fact, i) => (
          <li key={i}>{fact}</li>
        ))}
      </ul>
    </div>
  );
}

function DraftEditor({ value, readOnly, onChange }: { value: string; readOnly: boolean; onChange: (value: string) => void }) {
  const uid = useId();
  const tooLong = value.length > MAX_DRAFT_LENGTH;
  return (
    <div className="cs-field">
      <label className="cs-label" htmlFor={`${uid}-draft`}>
        Draft post
      </label>
      <textarea
        id={`${uid}-draft`}
        className="cs-input cs-textarea"
        rows={5}
        value={value}
        readOnly={readOnly}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={tooLong ? true : undefined}
        aria-describedby={`${uid}-count`}
      />
      <p id={`${uid}-count`} className={tooLong ? "cs-error" : "cs-hint"}>
        <span>{`${value.length} / ${MAX_DRAFT_LENGTH}`}</span>
        {tooLong && ` Shorten it to ${MAX_DRAFT_LENGTH} characters or fewer to save it.`}
      </p>
    </div>
  );
}

export function CompetitorResult({ analysis, onSaveDraft }: Props) {
  const [text, setText] = useState(analysis.draft.content);
  const [save, setSave] = useState<SaveState>("idle");
  const cannotSave = text.length > MAX_DRAFT_LENGTH || text.trim() === "" || save === "saving" || save === "saved";

  async function saveDraft() {
    setSave("saving");
    try {
      await onSaveDraft({ content: text, tags: competitorDraftTags(analysis.sourceUrl) });
      setSave("saved");
    } catch (err) {
      console.error(err); // the raw reason stays in the console; the customer gets the plain line
      setSave("failed");
    }
  }

  return (
    <div className="cs-result-box">
      <SourceHeader analysis={analysis} />
      <Facts facts={analysis.facts} />
      <DraftEditor
        value={text}
        readOnly={save === "saved" || save === "saving"}
        onChange={(value) => {
          setText(value);
          setSave("idle");
        }}
      />
      <div className="cs-actions">
        <button type="button" className="cs-btn cs-btn--primary" disabled={cannotSave} onClick={() => void saveDraft()}>
          {save === "saved" ? "Saved" : "Save as draft"}
        </button>
        <span className="cs-hint">{analysis.creditsUsed === 1 ? "1 credit used." : `${analysis.creditsUsed} credits used.`}</span>
      </div>
      {save === "saved" && (
        <p className="cs-result cs-result--ok" role="status">
          Saved as a draft. Find it under Drafts for review. It is not scheduled or posted.
        </p>
      )}
      {save === "failed" && (
        <p className="cs-result cs-result--bad" role="alert">
          We could not save the draft. Your text is still here. Please try again.
        </p>
      )}
    </div>
  );
}
