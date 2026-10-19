// "Add a source": the address of an RSS feed or a sitemap on the customer's own website, and the brand its drafts are for.
// CSV is shown but cannot be chosen yet.

import { useId, useState, type FormEvent } from "react";
import type { Brand } from "../../lib/api";
import { SOURCE_TYPES, SOURCE_TYPE_LABELS, URL_MAX_LENGTH, validateSourceUrl, type CreatableSourceType, type SourceType } from "../../lib/contentSources";
import { Message } from "./ContentSourcesParts";
import type { Msg } from "./useContentSources";

interface Props {
  brands: Brand[];
  busy: boolean;
  message: Msg | null;
  onAdd: (input: { sourceType: CreatableSourceType; sourceUrl: string; brandId: string }) => Promise<boolean>;
  onOpenPlan?: () => void;
}

const isCreatable = (t: SourceType): t is CreatableSourceType => t !== "csv";

export function ContentSourcesAddForm({ brands, busy, message, onAdd, onOpenPlan }: Props) {
  const uid = useId();
  const id = (part: string) => `${uid}-${part}`;
  const [type, setType] = useState<CreatableSourceType>("rss");
  const [urlText, setUrlText] = useState("");
  const [brandId, setBrandId] = useState("");

  const urlCheck = validateSourceUrl(urlText);
  const urlError = !urlCheck.ok && urlText.trim() !== "" ? urlCheck.error : null;

  async function submit(e?: FormEvent) {
    e?.preventDefault();
    if (!urlCheck.ok || busy) return;
    if (await onAdd({ sourceType: type, sourceUrl: urlCheck.url, brandId })) setUrlText("");
  }

  const urlLabel = type === "sitemap" ? "Sitemap address" : "Feed address";
  const urlHint = type === "sitemap" ? "The public https address of your sitemap file." : "The public https address of your feed.";

  return (
    <form className="cs-card" onSubmit={(e) => void submit(e)} noValidate>
      <h3 className="cs-card__title">Add a source</h3>
      <div className="cs-fields">
        <div className="cs-field cs-field--wide">
          <span className="cs-label" id={id("type-label")}>
            Source type
          </span>
          <div className="cs-segments" role="radiogroup" aria-labelledby={id("type-label")}>
            {SOURCE_TYPES.map((t) => (
              <label key={t} className={isCreatable(t) ? "cs-segment" : "cs-segment cs-segment--disabled"}>
                <input
                  type="radio"
                  name={id("type")}
                  value={t}
                  checked={type === t}
                  disabled={!isCreatable(t)}
                  aria-describedby={isCreatable(t) ? undefined : id("csv-hint")}
                  onChange={() => isCreatable(t) && setType(t)}
                />
                <span className="cs-segment__label">{SOURCE_TYPE_LABELS[t]}</span>
              </label>
            ))}
          </div>
          <p className="cs-hint" id={id("csv-hint")}>
            CSV upload is coming soon.
          </p>
        </div>

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
            onChange={(e) => setUrlText(e.target.value)}
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
        <button type="submit" className="cs-btn cs-btn--primary" disabled={!urlCheck.ok || busy}>
          Add source
        </button>
      </div>
      <Message msg={message} onOpenPlan={onOpenPlan} />
    </form>
  );
}
