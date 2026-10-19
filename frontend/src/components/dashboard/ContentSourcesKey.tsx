// "Connect your LazyRelay key": where the customer gives the companion service their own LazyRelay key, so it can make drafts
// in their account. The key is pasted into a masked field, sent once, and never shown again (only its last four characters).

import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { validateApiKey, type CredentialStatus } from "../../lib/contentSources";
import { Message } from "./ContentSourcesParts";
import type { Msg } from "./useContentSources";

const KEY_MAX_LENGTH = 137; // lzr_live_ plus up to 128 characters

interface Props {
  credential: CredentialStatus;
  busy: boolean;
  message: Msg | null;
  onSave: (key: string) => Promise<boolean>;
  onRemove: () => Promise<boolean>;
  onOpenApiKeys?: () => void;
}

export function ContentSourcesKey({ credential, busy, message, onSave, onRemove, onOpenApiKeys }: Props) {
  const uid = useId();
  const id = (part: string) => `${uid}-${part}`;
  const [value, setValue] = useState("");
  const [confirming, setConfirming] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const savedRef = useRef<HTMLParagraphElement>(null);
  const wasRegistered = useRef(credential.registered);

  // When the key state flips, focus follows it: onto the saved line after saving, into the paste field after removing.
  useEffect(() => {
    if (wasRegistered.current === credential.registered) return;
    wasRegistered.current = credential.registered;
    (credential.registered ? savedRef : inputRef).current?.focus();
  }, [credential.registered]);

  const check = validateApiKey(value);
  const error = value.trim() !== "" && !check.ok ? check.error : null;

  async function save() {
    if (!check.ok || busy) return;
    if (await onSave(check.key)) setValue("");
  }

  function closeConfirm() {
    setConfirming(false);
    document.getElementById(id("remove"))?.focus();
  }

  return (
    <section className="cs-card" aria-labelledby={id("title")}>
      <h3 className="cs-card__title" id={id("title")}>
        Connect your LazyRelay key
      </h3>
      <p className="cs-note" data-testid="key-explainer">
        Content Sources makes your drafts with your own LazyRelay key, so they land in your own account. Create a key on the API Keys tab, then paste it here.
      </p>
      {onOpenApiKeys && (
        <div>
          <button type="button" className="cs-btn cs-btn--link" onClick={onOpenApiKeys}>
            Go to the API Keys tab
          </button>
        </div>
      )}

      {credential.registered ? (
        <div className="cs-key-saved">
          <p className="cs-key-saved__line" tabIndex={-1} ref={savedRef}>
            Key ending in {credential.keyHint ?? "????"}
          </p>
          <button type="button" id={id("remove")} className="cs-btn cs-btn--quiet" disabled={busy} onClick={() => setConfirming(true)}>
            Remove key
          </button>
          {confirming && (
            <div
              className="cs-confirm"
              role="group"
              aria-label="Confirm key removal"
              onKeyDown={(e: KeyboardEvent<HTMLDivElement>) => {
                if (e.key === "Escape") {
                  e.stopPropagation();
                  closeConfirm();
                }
              }}
            >
              <p className="cs-confirm__text">Remove your saved key? Runs will stop until you save a key again.</p>
              <div className="cs-row-actions">
                <button type="button" className="cs-btn cs-btn--secondary" autoFocus onClick={closeConfirm}>
                  Keep key
                </button>
                <button
                  type="button"
                  className="cs-btn cs-btn--primary"
                  onClick={() => {
                    setConfirming(false);
                    void onRemove();
                  }}
                >
                  Yes, remove it
                </button>
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="cs-field">
          <label className="cs-label" htmlFor={id("key")}>
            LazyRelay key
          </label>
          <input
            id={id("key")}
            ref={inputRef}
            className="cs-input"
            type="password"
            autoComplete="new-password"
            spellCheck={false}
            maxLength={KEY_MAX_LENGTH}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void save();
              }
            }}
            aria-invalid={error ? true : undefined}
            aria-describedby={[id("key-hint"), error ? id("key-error") : null].filter(Boolean).join(" ")}
          />
          <p className="cs-hint" id={id("key-hint")}>
            It starts with lzr_live_. Only the last four characters are shown after you save it.
          </p>
          {error && (
            <p className="cs-error" id={id("key-error")}>
              {error}
            </p>
          )}
          <div className="cs-actions">
            <button type="button" className="cs-btn cs-btn--primary" disabled={!check.ok || busy} onClick={() => void save()}>
              Save key
            </button>
          </div>
        </div>
      )}
      <Message msg={message} />
    </section>
  );
}
