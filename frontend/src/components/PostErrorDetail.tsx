import { useState } from "react";
import { resolveErrorDisplay } from "../lib/errorMessages";

/** Shows a translated, customer-readable failure reason with the raw
 *  adapter/platform error tucked behind a toggle -- never shown by default,
 *  never discarded either. See errorMessages.ts for why this exists. */
export function PostErrorDetail({
  errorMessage,
  rawErrorMessage,
  platform,
}: {
  errorMessage: string | null;
  rawErrorMessage?: string | null;
  platform?: string;
}) {
  const [showTechnical, setShowTechnical] = useState(false);
  const { friendly, technical } = resolveErrorDisplay(errorMessage, rawErrorMessage, platform);

  return (
    <span className="not-verified">
      {`Not confirmed: ${friendly}`}
      {technical && (
        <>
          {" "}
          <button
            type="button"
            className="link-button"
            onClick={(e) => {
              e.stopPropagation();
              setShowTechnical((v) => !v);
            }}
          >
            {showTechnical ? "Hide details" : "Show details"}
          </button>
          {showTechnical && <span className="post-error-technical"> {technical}</span>}
        </>
      )}
    </span>
  );
}
