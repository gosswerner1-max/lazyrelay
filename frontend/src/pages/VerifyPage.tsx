import { useEffect, useState } from "react";
import { api, type PublicVerification } from "../lib/api";
import { Spinner } from "../components/Spinner";
import { BrandMark } from "../components/BrandMark";
import { PlatformIcon } from "../components/PlatformIcon";
import { RelaySignal } from "../components/RelaySignal";

export function VerifyPage({ id }: { id: string }) {
  const [result, setResult] = useState<PublicVerification | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api
      .getPublicVerification(id)
      .then(setResult)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
  }, [id]);

  if (loading) {
    return (
      <div className="bio-page-shell bio-page-loading">
        <Spinner />
      </div>
    );
  }

  if (error || !result) {
    return (
      <div className="bio-page-shell bio-page-notfound">
        <p>Nothing verified at this link.</p>
      </div>
    );
  }

  return (
    <div className="bio-page-shell">
      <div className="bio-page-card">
        <div className="verified" style={{ justifyContent: "center", marginBottom: 16 }}>
          <RelaySignal size={18} pulsing /> Confirmed live
        </div>
        {result.businessName && <h1>{result.businessName}</h1>}
        {result.platform && (
          <p className="bio-page-bio">
            <PlatformIcon platform={result.platform} size={16} /> {result.accountName ?? result.platform}
          </p>
        )}
        <p className="bio-page-bio">{result.content}</p>
        <p className="section-note">
          Verified live {result.verifiedAt ? new Date(result.verifiedAt).toLocaleString() : ""}
        </p>
        {result.platformPostUrl && (
          <a href={result.platformPostUrl} target="_blank" rel="noopener noreferrer" className="bio-page-link">
            View live on {result.platform}
          </a>
        )}
        <a href="https://lazyrelay.com" className="bio-page-footer-link">
          <BrandMark size={14} /> Independently verified by LazyRelay
        </a>
      </div>
    </div>
  );
}
