import { useMemo, useState, type ReactNode } from "react";
import { PlatformIcon } from "./PlatformIcon";
import type { SocialAccount } from "../lib/api";

function accountLabel(a: SocialAccount): string {
  return a.display_name ?? a.platform_account_id;
}

export function platformLabel(platform: string): string {
  return platform === "google-business" ? "Google Business" : platform;
}

/** The collapse/expand indicator shared by every collapsible group header
 *  in the account-picker family (AccountGroupList here, and
 *  MediaStorageList's platform-grouped storage view). */
export function GroupChevron({ open }: { open: boolean }) {
  return (
    <svg
      className={`account-picker-chevron${open ? " account-picker-chevron-open" : ""}`}
      width="10"
      height="10"
      viewBox="0 0 10 10"
      aria-hidden="true"
    >
      <path d="M2 1l5 4-5 4z" fill="currentColor" />
    </svg>
  );
}

interface AccountGroupListProps {
  accounts: SocialAccount[];
  /** A group holding one of these ids starts open; omit to start every group closed. */
  defaultOpenIds?: string[];
  /** Renders the open group's row list — full control over the wrapper (ul/div) and each row's markup. */
  renderGroupBody: (list: SocialAccount[]) => ReactNode;
  /** Overrides the group header's right-aligned count, e.g. "2/7 selected". Defaults to the plain count. */
  renderGroupBadge?: (list: SocialAccount[]) => ReactNode;
  searchPlaceholder?: string;
}

/**
 * Shared engine behind any "browse your connected accounts" UI: groups
 * accounts by platform into collapsible sections (a file-explorer-tree
 * pattern) plus a search box that filters accounts and force-opens any
 * group holding a match. Two current uses — the "post to" account picker
 * (AccountPicker, below) and the Social Platforms tab's manage/disconnect
 * list — share this instead of each re-implementing the same grouping,
 * search, and open/closed state. See AccountPicker's own doc comment for
 * why this exists at all.
 */
export function AccountGroupList({
  accounts,
  defaultOpenIds,
  renderGroupBody,
  renderGroupBadge,
  searchPlaceholder = "Search connected accounts...",
}: AccountGroupListProps) {
  const [query, setQuery] = useState("");
  // Platforms the user has explicitly clicked open/closed, overriding the
  // default (open if it holds a defaultOpenIds match, or if searching).
  const [toggledPlatforms, setToggledPlatforms] = useState<Set<string>>(new Set());

  const trimmedQuery = query.trim().toLowerCase();

  const groups = useMemo(() => {
    const byPlatform = new Map<string, SocialAccount[]>();
    for (const a of accounts) {
      const matches =
        !trimmedQuery ||
        accountLabel(a).toLowerCase().includes(trimmedQuery) ||
        a.platform.toLowerCase().includes(trimmedQuery);
      if (!matches) continue;
      const list = byPlatform.get(a.platform) ?? [];
      list.push(a);
      byPlatform.set(a.platform, list);
    }
    return [...byPlatform.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [accounts, trimmedQuery]);

  function isOpen(platform: string, list: SocialAccount[]): boolean {
    if (trimmedQuery) return true;
    const defaultOpen = !!defaultOpenIds && list.some((a) => defaultOpenIds.includes(a.id));
    return toggledPlatforms.has(platform) ? !defaultOpen : defaultOpen;
  }

  function toggleGroup(platform: string) {
    setToggledPlatforms((prev) => {
      const next = new Set(prev);
      if (next.has(platform)) next.delete(platform);
      else next.add(platform);
      return next;
    });
  }

  return (
    <div>
      <input
        type="text"
        className="account-picker-search"
        placeholder={searchPlaceholder}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <div className="account-picker-groups">
        {groups.length === 0 && <p className="muted">No accounts match "{query}".</p>}
        {groups.map(([platform, list]) => {
          const open = isOpen(platform, list);
          return (
            <div key={platform} className="account-picker-group">
              <button
                type="button"
                className="account-picker-group-header"
                onClick={() => toggleGroup(platform)}
                aria-expanded={open}
              >
                <GroupChevron open={open} />
                <PlatformIcon platform={platform} size={14} />
                <span className="account-picker-group-name">{platformLabel(platform)}</span>
                <span className="account-picker-group-count">
                  {renderGroupBadge ? renderGroupBadge(list) : list.length}
                </span>
              </button>
              {open && renderGroupBody(list)}
            </div>
          );
        })}
      </div>
    </div>
  );
}

interface AccountPickerProps {
  accounts: SocialAccount[];
  selectedIds: string[];
  onToggle: (id: string) => void;
}

/**
 * Account selector for the "post to" / "post to (recurring)" forms.
 *
 * A flat checkbox list works for a handful of accounts, but a customer with
 * 50-100 connected accounts has no way to find one — see Werner's own
 * screenshot, 2026-08-20. This groups accounts by platform into collapsible
 * sections (the same expand/collapse pattern as a file-explorer tree, which
 * he specifically asked for) plus a search box, and keeps whatever's already
 * selected visible as removable chips so a filter/collapse never hides a
 * pick that was already made.
 */
export function AccountPicker({ accounts, selectedIds, onToggle }: AccountPickerProps) {
  const selectedAccounts = useMemo(
    () => selectedIds.map((id) => accounts.find((a) => a.id === id)).filter((a): a is SocialAccount => !!a),
    [selectedIds, accounts],
  );

  return (
    <div className="account-picker">
      {selectedAccounts.length > 0 && (
        <div className="account-picker-selected">
          {selectedAccounts.map((a) => (
            <button
              type="button"
              key={a.id}
              className="account-chip"
              onClick={() => onToggle(a.id)}
              title={`Remove ${accountLabel(a)}`}
            >
              <PlatformIcon platform={a.platform} size={12} />
              {accountLabel(a)}
              <span className="account-chip-remove" aria-hidden="true">
                &times;
              </span>
            </button>
          ))}
        </div>
      )}
      <AccountGroupList
        accounts={accounts}
        defaultOpenIds={selectedIds}
        renderGroupBadge={(list) => {
          const selectedInGroup = list.filter((a) => selectedIds.includes(a.id)).length;
          return selectedInGroup > 0 ? `${selectedInGroup}/${list.length}` : list.length;
        }}
        renderGroupBody={(list) => (
          <div className="account-checkbox-list account-picker-group-list">
            {list.map((a) => (
              <label key={a.id} className="account-checkbox">
                <input type="checkbox" checked={selectedIds.includes(a.id)} onChange={() => onToggle(a.id)} />
                <PlatformIcon platform={a.platform} size={14} />
                {accountLabel(a)}
              </label>
            ))}
          </div>
        )}
      />
    </div>
  );
}
