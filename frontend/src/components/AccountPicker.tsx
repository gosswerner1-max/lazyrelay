import { useMemo, useState } from "react";
import { PlatformIcon } from "./PlatformIcon";
import type { SocialAccount } from "../lib/api";

interface AccountPickerProps {
  accounts: SocialAccount[];
  selectedIds: string[];
  onToggle: (id: string) => void;
}

function accountLabel(a: SocialAccount): string {
  return a.display_name ?? a.platform_account_id;
}

function platformLabel(platform: string): string {
  return platform === "google-business" ? "Google Business" : platform;
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
  const [query, setQuery] = useState("");
  // Platforms the user has explicitly clicked open/closed, overriding the
  // default (open if it holds a selected account, or if searching).
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

  const selectedAccounts = useMemo(
    () => selectedIds.map((id) => accounts.find((a) => a.id === id)).filter((a): a is SocialAccount => !!a),
    [selectedIds, accounts],
  );

  function isOpen(platform: string, list: SocialAccount[]): boolean {
    if (trimmedQuery) return true;
    const defaultOpen = list.some((a) => selectedIds.includes(a.id));
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
      <input
        type="text"
        className="account-picker-search"
        placeholder="Search connected accounts..."
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <div className="account-picker-groups">
        {groups.length === 0 && <p className="muted">No accounts match "{query}".</p>}
        {groups.map(([platform, list]) => {
          const open = isOpen(platform, list);
          const selectedInGroup = list.filter((a) => selectedIds.includes(a.id)).length;
          return (
            <div key={platform} className="account-picker-group">
              <button
                type="button"
                className="account-picker-group-header"
                onClick={() => toggleGroup(platform)}
                aria-expanded={open}
              >
                <svg
                  className={`account-picker-chevron${open ? " account-picker-chevron-open" : ""}`}
                  width="10"
                  height="10"
                  viewBox="0 0 10 10"
                  aria-hidden="true"
                >
                  <path d="M2 1l5 4-5 4z" fill="currentColor" />
                </svg>
                <PlatformIcon platform={platform} size={14} />
                <span className="account-picker-group-name">{platformLabel(platform)}</span>
                <span className="account-picker-group-count">
                  {selectedInGroup > 0 ? `${selectedInGroup}/${list.length}` : list.length}
                </span>
              </button>
              {open && (
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
            </div>
          );
        })}
      </div>
    </div>
  );
}
