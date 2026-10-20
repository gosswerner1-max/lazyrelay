// The answer to one analysis, read in two columns: how the competitor's page is built on the left, what to change in your
// own content on the right. Text only. Nothing is saved or posted from here; the customer reads it and can copy it.

import { useEffect, useId, useRef, useState } from "react";
import {
  BASED_ON_TEXT,
  NO_ADJUSTMENTS,
  NO_SECTIONS,
  blueprintToText,
  ctaLine,
  hookLabel,
  type CompetitorBlueprint,
} from "../../lib/competitorBlueprint";

type CopyState = "idle" | "copied" | "failed";

/** Only a plain web link is ever made clickable. Anything else is shown as text. */
function webLink(raw: string): URL | null {
  try {
    const url = new URL(raw);
    return url.protocol === "https:" || url.protocol === "http:" ? url : null;
  } catch {
    return null;
  }
}

function SourceHeader({ result }: { result: CompetitorBlueprint }) {
  const link = webLink(result.sourceUrl);
  return (
    <div className="cs-source">
      <span className="cs-chip">Web page</span>
      <h4 className="cs-source__title">{result.title}</h4>
      {link ? (
        <a className="cs-btn--link cs-bp__link" href={link.href} target="_blank" rel="noopener noreferrer nofollow">
          {`${link.host}${link.pathname === "/" ? "" : link.pathname}`}
        </a>
      ) : (
        <span className="cs-hint">{result.sourceUrl}</span>
      )}
    </div>
  );
}

function Structure({ result }: { result: CompetitorBlueprint }) {
  const { hook, sections, cta } = result.blueprint;
  const id = useId();
  return (
    <section className="cs-bp__col" aria-labelledby={`${id}-h`}>
      <h4 className="cs-bp__heading" id={`${id}-h`}>
        Competitor structure
      </h4>
      <div className="cs-bp__item">
        <p className="cs-bp__label">How it opens</p>
        <p className="cs-bp__strong">{hookLabel(hook.type)}</p>
        {hook.note !== "" && <p className="cs-bp__text">{hook.note}</p>}
      </div>
      <div className="cs-bp__item">
        <p className="cs-bp__label">How it is laid out</p>
        {sections.length === 0 ? (
          <p className="cs-bp__text">{NO_SECTIONS}</p>
        ) : (
          <ol className="cs-bp__steps">
            {sections.map((s, i) => (
              <li key={`${s.order}-${i}`} className="cs-bp__step">
                <span className="cs-bp__num">{i + 1}.</span>
                <span className="cs-bp__body">
                  <span className="cs-bp__strong">{s.role}</span>
                  <span className="cs-bp__text">{s.summary}</span>
                </span>
              </li>
            ))}
          </ol>
        )}
      </div>
      <div className="cs-bp__item">
        <p className="cs-bp__label">Call to action</p>
        <p className="cs-bp__text">{ctaLine(cta)}</p>
      </div>
    </section>
  );
}

function Adjustments({ items }: { items: string[] }) {
  const id = useId();
  return (
    <section className="cs-bp__col" aria-labelledby={`${id}-h`}>
      <h4 className="cs-bp__heading" id={`${id}-h`}>
        Recommended adjustments
      </h4>
      {items.length === 0 ? (
        <p className="cs-bp__item cs-bp__text">{NO_ADJUSTMENTS}</p>
      ) : (
        <ul className="cs-bp__list">
          {items.map((a, i) => (
            <li key={i} className="cs-bp__item cs-bp__text">
              {a}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Copies through the clipboard when the browser allows it. When it does not, the text is shown to copy by hand. */
function useCopy(text: string) {
  const [state, setState] = useState<CopyState>("idle");
  async function copy() {
    try {
      if (!navigator.clipboard?.writeText) {
        setState("failed");
        return;
      }
      await navigator.clipboard.writeText(text);
      setState("copied");
    } catch (err) {
      console.error(err); // the raw reason stays in the console; the customer gets the plain line
      setState("failed");
    }
  }
  return { state, copy };
}

function CopyFallback({ text }: { text: string }) {
  const id = useId();
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => ref.current?.select(), []);
  return (
    <div className="cs-field">
      <label className="cs-label" htmlFor={id}>
        Blueprint text to copy
      </label>
      <textarea id={id} ref={ref} className="cs-input cs-textarea" rows={8} readOnly value={text} />
    </div>
  );
}

export function BlueprintResult({ result }: { result: CompetitorBlueprint }) {
  const text = blueprintToText(result);
  const { state, copy } = useCopy(text);
  return (
    <div className="cs-result-box cs-bp">
      <SourceHeader result={result} />
      <div className="cs-bp__grid">
        <Structure result={result} />
        <Adjustments items={result.blueprint.adjustments} />
      </div>
      <div className="cs-actions">
        <button type="button" className="cs-btn cs-btn--primary" onClick={() => void copy()}>
          Copy blueprint
        </button>
        <span className="cs-hint">{result.creditsUsed === 1 ? "1 credit used." : `${result.creditsUsed} credits used.`}</span>
      </div>
      {state === "copied" && (
        <p className="cs-result cs-result--ok" role="status">
          Copied.
        </p>
      )}
      {state === "failed" && (
        <>
          <p className="cs-result cs-result--bad" role="alert">
            We could not copy it for you. The text is below, so you can copy it yourself.
          </p>
          <CopyFallback text={text} />
        </>
      )}
      <p className="cs-hint">{BASED_ON_TEXT}</p>
    </div>
  );
}
