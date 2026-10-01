import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { api, type WhopChallenge } from "../lib/api";

/** The Whop connect dialog (the Whop tile opens it). Whop has no sign-in redirect, and one LazyRelay app works in every
 *  community that installed it, so the owner has to PROVE the community is theirs. Three plain steps, one at a time:
 *    1. install the LazyRelay app in the community (a link the backend serves, never hardcoded here),
 *    2. say which community (its biz_ id) and get a one-time code,
 *    3. post that code in a forum as the owner or an admin, then press check.
 *  When the check passes the backend hands back a selection token and the normal "which forum" picker takes over
 *  (Dashboard.tsx), exactly like Slack's channel picker. Built on the same .modal-overlay/.modal-card styling and dialog
 *  behaviour as MastodonServerModal. */
export function WhopConnectModal({ onCancel, onSelection }: { onCancel: () => void; onSelection: (selectionToken: string) => void }) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const [step, setStep] = useState<"install" | "community" | "code">("install");
  const [installUrl, setInstallUrl] = useState<string | null>(null);
  const [company, setCompany] = useState("");
  const [challenge, setChallenge] = useState<WhopChallenge | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialogRef.current?.focus();
    return () => opener?.focus();
  }, []);

  useEffect(() => {
    let alive = true;
    api
      .whopConfig()
      .then((c) => alive && setInstallUrl(c.installUrl))
      .catch((err) => alive && setError(err instanceof Error ? err.message : "Could not load the Whop install link. Try again."));
    return () => {
      alive = false;
    };
  }, []);

  function handleKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Escape") {
      e.stopPropagation();
      onCancel();
      return;
    }
    if (e.key !== "Tab") return;
    const focusable = dialogRef.current?.querySelectorAll<HTMLElement>("input:not([disabled]), button:not([disabled]), a[href]");
    if (!focusable || focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && (active === first || active === dialogRef.current)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  }

  async function handleGetCode(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      setChallenge(await api.whopStartChallenge(company.trim()));
      setStep("code");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start the connection. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function handleCheck() {
    if (busy || !challenge) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.whopVerify(challenge.challengeId);
      onSelection(result.selectionToken);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not check the code. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function handleCopy() {
    if (!challenge) return;
    try {
      await navigator.clipboard.writeText(challenge.code);
      setCopied(true);
    } catch {
      setCopied(false); // the code is shown on screen, the customer can select it by hand
    }
  }

  return (
    <div className="modal-overlay" onClick={onCancel} onKeyDown={handleKeyDown}>
      <div
        ref={dialogRef}
        className="modal-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        style={{ outline: "none" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <h2 id={titleId}>Connect Whop</h2>
        </div>

        {step === "install" && (
          <div style={{ marginTop: "16px" }}>
            <p className="modal-subtitle">
              <strong>Step 1 of 3.</strong> Install the LazyRelay app in your Whop community. On the Whop page that opens, choose your community and approve the three permissions it asks for. Only the owner of a community can do this.
            </p>
            {installUrl ? (
              <a className="cta" href={installUrl} target="_blank" rel="noopener noreferrer" style={{ display: "inline-block", marginTop: "8px" }}>
                Open the Whop install page
              </a>
            ) : (
              !error && <p className="field-hint">Loading the install link...</p>
            )}
            <div className="modal-actions">
              <button type="button" onClick={() => { setError(null); setStep("community"); }} disabled={!installUrl}>
                I have installed it
              </button>
              <button type="button" className="btn-outline" onClick={onCancel}>
                Cancel
              </button>
            </div>
          </div>
        )}

        {step === "community" && (
          <form onSubmit={handleGetCode} style={{ marginTop: "16px" }}>
            <p className="modal-subtitle">
              <strong>Step 2 of 3.</strong> Which community is it? Paste its id, which starts with biz_. You can see it in the address of your Whop dashboard (the part that looks like biz_ followed by letters and numbers).
            </p>
            <label htmlFor="whop-company" style={{ display: "block", margin: "8px 0 6px" }}>
              Community id
            </label>
            <input
              id="whop-company"
              type="text"
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              placeholder="biz_xxxxxxxxxxxxxx"
              value={company}
              onChange={(e) => setCompany(e.target.value)}
              style={{ width: "100%", boxSizing: "border-box" }}
              required
            />
            <div className="modal-actions">
              <button type="submit" disabled={busy || !company.trim()}>
                {busy ? "Checking..." : "Get my code"}
              </button>
              <button type="button" className="btn-outline" onClick={() => { setError(null); setStep("install"); }}>
                Back
              </button>
            </div>
          </form>
        )}

        {step === "code" && challenge && (
          <div style={{ marginTop: "16px" }}>
            <p className="modal-subtitle">
              <strong>Step 3 of 3.</strong> Prove the community is yours. Sign in to Whop as the owner or an admin of <strong>{challenge.companyTitle}</strong> and make a new post in one of these forums with this code in it:
            </p>
            <p style={{ margin: "10px 0" }}>
              <code data-testid="whop-code" style={{ fontSize: "1.1rem", padding: "6px 10px", userSelect: "all" }}>{challenge.code}</code>{" "}
              <button type="button" className="btn-outline" onClick={handleCopy}>
                {copied ? "Copied" : "Copy"}
              </button>
            </p>
            <ul className="field-hint" style={{ margin: "0 0 8px 18px" }}>
              {challenge.forums.map((f) => (
                <li key={f.id}>{f.name}</li>
              ))}
            </ul>
            <p className="field-hint">
              Make it a new post, not a comment. The code works once and stops working in 15 minutes. You can delete the post as soon as LazyRelay confirms it. Then press the button below.
            </p>
            <div className="modal-actions">
              <button type="button" onClick={handleCheck} disabled={busy}>
                {busy ? "Checking..." : "I posted it, check now"}
              </button>
              <button type="button" className="btn-outline" onClick={() => { setError(null); setChallenge(null); setStep("community"); }}>
                Back
              </button>
            </div>
          </div>
        )}

        {error && (
          <p role="alert" className="error" style={{ margin: "12px 0 0" }}>
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
