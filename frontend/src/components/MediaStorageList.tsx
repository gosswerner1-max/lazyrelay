import { useMemo, useState, type ReactNode } from "react";
import { PlatformIcon } from "./PlatformIcon";
import { platformLabel, GroupChevron } from "./AccountPicker";
import { formatBytes } from "../lib/format";
import type { MediaFile } from "../lib/api";

interface MediaStorageListProps {
  mediaFiles: MediaFile[];
  /** Renders one file's row inside an open group — same markup the Storage
   *  tab already used (thumbnail, alt-text input, delete button). */
  renderItem: (m: MediaFile) => ReactNode;
}

const UNUSED_GROUP = "__unused__";

/**
 * Groups the Storage tab's media list by which platform(s) each file has
 * actually been posted to — same collapsible/searchable pattern as
 * AccountGroupList, applied to the "what's using my storage" question
 * Werner asked for, 2026-08-20. Not built on AccountGroupList itself: a
 * media file can belong to MORE THAN ONE platform group at once (the same
 * upload posted to Facebook and Instagram counts toward both), which is a
 * different shape than one-account-one-platform, plus each group header
 * here shows a total-size sum instead of a plain item count. Sorted by
 * total size descending — the biggest group IS the answer to "what's using
 * the most storage," so that ordering does the actual work, no need to
 * open anything to see it.
 *
 * Files that have never been attached to a post (platforms: []) land in
 * their own "Not used in a post yet" group rather than being silently
 * dropped or double-counted into every platform.
 */
export function MediaStorageList({ mediaFiles, renderItem }: MediaStorageListProps) {
  const [query, setQuery] = useState("");
  const [toggledGroups, setToggledGroups] = useState<Set<string>>(new Set());

  const trimmedQuery = query.trim().toLowerCase();

  const groups = useMemo(() => {
    const byGroup = new Map<string, MediaFile[]>();
    for (const m of mediaFiles) {
      const matches =
        !trimmedQuery ||
        (m.alt_text ?? "").toLowerCase().includes(trimmedQuery) ||
        m.platforms.some((p) => p.toLowerCase().includes(trimmedQuery)) ||
        (m.platforms.length === 0 && "not used in a post yet".includes(trimmedQuery));
      if (!matches) continue;
      const keys = m.platforms.length > 0 ? m.platforms : [UNUSED_GROUP];
      for (const key of keys) {
        const list = byGroup.get(key) ?? [];
        list.push(m);
        byGroup.set(key, list);
      }
    }
    return [...byGroup.entries()].sort(
      (a, b) => b[1].reduce((sum, m) => sum + m.size_bytes, 0) - a[1].reduce((sum, m) => sum + m.size_bytes, 0),
    );
  }, [mediaFiles, trimmedQuery]);

  function isOpen(key: string): boolean {
    return trimmedQuery.length > 0 || toggledGroups.has(key);
  }

  function toggleGroup(key: string) {
    setToggledGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  return (
    <div>
      <input
        type="text"
        className="account-picker-search"
        placeholder="Search by platform or alt text..."
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <p className="section-note">
        A file posted to more than one platform counts toward each of them, so these totals can add up to more than
        your overall storage used above.
      </p>
      <div className="account-picker-groups">
        {groups.length === 0 && <p className="muted">No files match "{query}".</p>}
        {groups.map(([key, list]) => {
          const open = isOpen(key);
          const totalBytes = list.reduce((sum, m) => sum + m.size_bytes, 0);
          return (
            <div key={key} className="account-picker-group">
              <button
                type="button"
                className="account-picker-group-header"
                onClick={() => toggleGroup(key)}
                aria-expanded={open}
              >
                <GroupChevron open={open} />
                {key === UNUSED_GROUP ? (
                  <span className="account-picker-group-name">Not used in a post yet</span>
                ) : (
                  <>
                    <PlatformIcon platform={key} size={14} />
                    <span className="account-picker-group-name">{platformLabel(key)}</span>
                  </>
                )}
                <span className="account-picker-group-count">
                  {formatBytes(totalBytes)} &middot; {list.length} file{list.length === 1 ? "" : "s"}
                </span>
              </button>
              {open && <ul className="media-list account-picker-group-list">{list.map((m) => renderItem(m))}</ul>}
            </div>
          );
        })}
      </div>
    </div>
  );
}
