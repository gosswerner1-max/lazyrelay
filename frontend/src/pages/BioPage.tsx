import { useEffect, useState } from "react";
import { api, type PublicBioPage } from "../lib/api";
import { Spinner } from "../components/Spinner";
import { BrandMark } from "../components/BrandMark";

export function BioPage({ slug }: { slug: string }) {
  const [page, setPage] = useState<PublicBioPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api
      .getPublicBioPage(slug)
      .then(setPage)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
  }, [slug]);

  if (loading) {
    return (
      <div className="bio-page-shell bio-page-loading">
        <Spinner />
      </div>
    );
  }

  if (error || !page) {
    return (
      <div className="bio-page-shell bio-page-notfound">
        <p>This page doesn't exist.</p>
      </div>
    );
  }

  return (
    <div className="bio-page-shell">
      <div className="bio-page-card">
        {page.avatarUrl && <img src={page.avatarUrl} alt="" className="bio-page-avatar" />}
        {page.title && <h1>{page.title}</h1>}
        {page.bio && <p className="bio-page-bio">{page.bio}</p>}
        <div className="bio-page-links">
          {page.links.length === 0 ? (
            <p className="bio-page-empty">No links yet.</p>
          ) : (
            page.links.map((link) => (
              <a key={link.id} href={link.url} target="_blank" rel="noopener noreferrer" className="bio-page-link">
                {link.label}
              </a>
            ))
          )}
        </div>
        <a href="https://lazyrelay.com" className="bio-page-footer-link">
          <BrandMark size={14} /> Made with LazyRelay
        </a>
      </div>
    </div>
  );
}
