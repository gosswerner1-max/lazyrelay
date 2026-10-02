import { useId, useState } from "react";

export interface FaqEntry {
  q: string;
  a: string;
}

// Answers stay in the DOM when collapsed (only visually hidden) so the
// prerendered HTML and any LLM/search scraper sees every Q&A pair without
// executing click handlers.
export function FaqAccordion({ items }: { items: readonly FaqEntry[] }) {
  const baseId = useId();
  const [openIndex, setOpenIndex] = useState<number | null>(null);

  return (
    <div className="faq-list">
      {items.map((item, i) => {
        const open = openIndex === i;
        const panelId = `${baseId}-panel-${i}`;
        const buttonId = `${baseId}-button-${i}`;
        return (
          <div className={`faq-item${open ? " faq-item-open" : ""}`} key={item.q}>
            <h3>
              <button
                type="button"
                id={buttonId}
                className="faq-trigger"
                aria-expanded={open}
                aria-controls={panelId}
                onClick={() => setOpenIndex(open ? null : i)}
              >
                <span>{item.q}</span>
                <span className="faq-chevron" aria-hidden="true" />
              </button>
            </h3>
            <div id={panelId} role="region" aria-labelledby={buttonId} className="faq-panel">
              <div className="faq-panel-inner">
                <p>{item.a}</p>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// FAQPage structured data built from the same array the accordion renders,
// so the markup and the visible text cannot drift apart.
export function faqJsonLd(items: readonly FaqEntry[]): string {
  return JSON.stringify({
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: items.map((item) => ({
      "@type": "Question",
      name: item.q,
      acceptedAnswer: { "@type": "Answer", text: item.a },
    })),
  }).replace(/</g, "\\u003c");
}
