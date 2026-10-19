// "Prove you own this website": the three ways to show the website is the customer's, each with the exact text to publish and a
// copy button, and a Check now button. The text comes from the service as it is; nothing here builds or changes it.

import { useEffect, useId, useRef } from "react";
import type { ServiceSource, Verification } from "../../lib/contentSources";
import { CopyButton } from "./ContentSourcesParts";
import type { CheckState } from "./useContentSources";

/** The answer to a check: verified, the plain reasons it did not work, or a plain error. Always present so it is announced. */
export function CheckResult({ check, checking }: { check: CheckState | null; checking: boolean }) {
  return (
    <div className="cs-check" role="status" aria-label="Result of the check">
      {checking && <p className="cs-result cs-result--info">Checking...</p>}
      {!checking && check?.kind === "ok" && <p className="cs-result cs-result--ok">Verified. This website is proven, so this source can run.</p>}
      {!checking && check?.kind === "reasons" && (
        <>
          <p className="cs-result cs-result--bad">We could not prove it yet. Here is what we found:</p>
          <ul className="cs-reasons">
            {check.lines.map((line) => (
              <li key={line.method}>
                <strong>{line.label}:</strong> {line.text}
              </li>
            ))}
          </ul>
        </>
      )}
      {!checking && check?.kind === "error" && (
        <p className="cs-result cs-result--bad" role="alert">
          {check.text}
        </p>
      )}
    </div>
  );
}

interface Props {
  source: ServiceSource;
  verification: Verification;
  busy: boolean;
  check: CheckState | null;
  checking: boolean;
  onCheck: () => void;
  onClose: () => void;
}

function Code({ children }: { children: string }) {
  return <code className="cs-code">{children}</code>;
}

export function ContentSourcesProof({ source, verification, busy, check, checking, onCheck, onClose }: Props) {
  const uid = useId();
  const titleId = `${uid}-title`;
  const heading = useRef<HTMLHeadingElement>(null);
  const { well_known: wk, meta_tag: mt, dns_txt: dns } = verification.methods;

  useEffect(() => heading.current?.focus(), []); // the panel has just opened: put the reader at its start

  return (
    <section className="cs-card cs-proof" aria-labelledby={titleId}>
      <h3 className="cs-card__title" id={titleId} tabIndex={-1} ref={heading}>
        Prove you own this website
      </h3>
      <p className="cs-note">
        This is for {source.sourceUrl ?? "your source"}. Do just one of these three. The text file is the easiest.
      </p>

      <div className="cs-method">
        <h4 className="cs-method__title">Text file (the easiest)</h4>
        <p className="cs-note">Make a text file that anyone can open at this address:</p>
        <Code>{wk.url}</Code>
        <CopyButton text={wk.url} label="Copy address" />
        <p className="cs-note">It must contain only this one line:</p>
        <Code>{wk.content}</Code>
        <CopyButton text={wk.content} label="Copy file text" />
      </div>

      <div className="cs-method">
        <h4 className="cs-method__title">Tag on your home page</h4>
        <p className="cs-note">Add this tag {mt.placement}:</p>
        <Code>{mt.html}</Code>
        <CopyButton text={mt.html} label="Copy tag" />
      </div>

      <div className="cs-method">
        <h4 className="cs-method__title">DNS record</h4>
        <p className="cs-note">Add a TXT record with this name:</p>
        <Code>{dns.name}</Code>
        <CopyButton text={dns.name} label="Copy record name" />
        <p className="cs-note">and this value:</p>
        <Code>{dns.value}</Code>
        <CopyButton text={dns.value} label="Copy record value" />
      </div>

      <div className="cs-actions">
        <button type="button" className="cs-btn cs-btn--primary" disabled={busy} onClick={onCheck}>
          Check now
        </button>
        <button type="button" className="cs-btn cs-btn--secondary" onClick={onClose}>
          Close
        </button>
      </div>
      <CheckResult check={check} checking={checking} />
    </section>
  );
}
