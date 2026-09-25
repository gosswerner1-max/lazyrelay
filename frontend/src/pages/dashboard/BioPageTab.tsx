// The "Bio Page" tab — extracted verbatim from the original single-file Dashboard.tsx
// (split 2026-09-25, pure mechanical move: same JSX, same handlers, same
// state — nothing added, removed, or reworded). State and handlers still
// live in one place (useDashboardState.tsx, called once by Dashboard.tsx)
// and reach this file through DashboardContext.

import { Spinner } from "../../components/Spinner";
import { useDashboard } from "./DashboardContext";

export function BioPageTab() {
  const {
    bioPage,
    bioLoading,
    bioSaving,
    bioSlug,
    setBioSlug,
    bioTitle,
    setBioTitle,
    bioBio,
    setBioBio,
    bioLinkLabel,
    setBioLinkLabel,
    bioLinkUrl,
    setBioLinkUrl,
    bioLinkBusy,
    handleSaveBioPage,
    handleAddBioLink,
    handleDeleteBioLink,
  } = useDashboard();

  return (
    <section>
      <h2>Link-in-bio page</h2>
      {bioLoading ? (
        <Spinner />
      ) : (
        <>
          <p className="muted">
            A public page for your Instagram/TikTok bio link. Customers land here and see the links you choose.
          </p>
          <form onSubmit={handleSaveBioPage} className="schedule-form">
            <label>
              Page URL
              <input
                type="text"
                value={bioSlug}
                onChange={(e) => setBioSlug(e.target.value.toLowerCase())}
                placeholder="your-name"
                pattern="[a-z0-9-]{3,40}"
                required
              />
            </label>
            {bioSlug && (
              <p className="bio-page-editor-preview">
                lazyrelay.com/bio/{bioSlug}
              </p>
            )}
            <label>
              Title
              <input type="text" value={bioTitle} onChange={(e) => setBioTitle(e.target.value)} maxLength={100} />
            </label>
            <label>
              Bio
              <textarea value={bioBio} onChange={(e) => setBioBio(e.target.value)} maxLength={500} />
            </label>
            <div className="schedule-form-actions">
              <button type="submit" disabled={bioSaving}>
                {bioSaving ? "Saving..." : "Save"}
              </button>
            </div>
          </form>

          {bioPage && (
            <>
              <h3>Links</h3>
              {bioPage.links.length === 0 ? (
                <p className="empty">No links yet. Add one below.</p>
              ) : (
                <ul className="bio-link-list">
                  {bioPage.links.map((link) => (
                    <li key={link.id}>
                      <span className="bio-link-label">{link.label}</span>
                      <span className="bio-link-url">{link.url}</span>
                      <button className="btn-outline" onClick={() => handleDeleteBioLink(link.id)}>
                        Delete
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <form onSubmit={handleAddBioLink} className="bio-link-add-form">
                <input
                  type="text"
                  placeholder="Label (e.g. Shop now)"
                  value={bioLinkLabel}
                  onChange={(e) => setBioLinkLabel(e.target.value)}
                />
                <input
                  type="url"
                  placeholder="https://..."
                  value={bioLinkUrl}
                  onChange={(e) => setBioLinkUrl(e.target.value)}
                />
                <button type="submit" className="btn-outline" disabled={bioLinkBusy}>
                  {bioLinkBusy ? "Adding..." : "Add link"}
                </button>
              </form>
            </>
          )}
        </>
      )}
    </section>
  );
}
