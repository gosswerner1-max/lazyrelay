import type { Guide } from "../../lib/byokGuides";
import "../../styles/byok-panels.css";
import "../../styles/whatsapp-chat.css";

// A collapsible, numbered setup guide for a customer's own Meta or X credentials (content and sources: lib/byokGuides.ts). It uses a
// native <details>: it opens and closes with no script and no animation, works with a keyboard and a screen reader, and keeps the
// reading order. Each step is one action; anything the platforms' pages did not confirm is shown as a plain "check the current screen" note.

interface Props {
  guide: Guide;
  /** Start opened (tests; a person who has not connected yet). */
  defaultOpen?: boolean;
}

export function ByokGuide({ guide, defaultOpen = false }: Props) {
  return (
    <details className="byok-guide" open={defaultOpen || undefined}>
      <summary className="byok-guide__summary">
        <span>{guide.title}</span>
      </summary>
      <div className="byok-guide__body">
        <p className="byok-guide__intro">{guide.intro}</p>
        <ol className="byok-guide__steps">
          {guide.steps.map((step) => (
            <li key={step.title}>
              <strong className="byok-guide__step-title">{step.title}</strong>
              <span className="byok-guide__action">{step.action}</span>
              {step.note && <span className="byok-guide__note">{step.note}</span>}
              {step.link && (
                <a className="byok-guide__link" href={step.link.url} target="_blank" rel="noopener noreferrer">
                  {step.link.label}
                </a>
              )}
            </li>
          ))}
        </ol>
        <p className="byok-guide__footer">
          {guide.footer}{" "}
          <a href={guide.help.url} target="_blank" rel="noopener noreferrer">
            {guide.help.label}
          </a>
        </p>
      </div>
    </details>
  );
}
