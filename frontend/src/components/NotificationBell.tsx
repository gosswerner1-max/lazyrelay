import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";

const POLL_INTERVAL_MS = 45_000;

interface NotificationBellProps {
  /** Jumps the dashboard to the given tab — passed in rather than importing
   *  Tab/setTab directly, so this component stays decoupled from
   *  Dashboard's own state. */
  onOpenTab: (tab: "Mentions" | "DMs") => void;
}

/**
 * A bell in the header showing whether there's anything new in Mentions or
 * DMs, without the customer having to open either tab to find out — see
 * werner-brain 2026-08-20 daily note ("nobody has an idea if there is a dm
 * or a mention"). Reads GET /notifications/summary, a cheap query against
 * the mention/DM cache tables kept fresh by mentionsAndDmsPoller.ts — this
 * component itself never triggers a live platform call. Polls on an
 * interval while mounted so the badge stays roughly current without a full
 * page reload; opening either tab clears its own count server-side (GET
 * /mentions and GET /dms both bump notification_view_state), which the
 * next poll picks up.
 */
export function NotificationBell({ onOpenTab }: NotificationBellProps) {
  const [summary, setSummary] = useState<{ newMentions: number; newDms: number } | null>(null);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    function refresh() {
      api
        .getNotificationSummary()
        .then((res) => {
          if (!cancelled) setSummary(res);
        })
        .catch(() => {
          // Quiet failure — a stale/missing badge isn't worth surfacing an
          // error for, and the next poll tries again.
        });
    }
    refresh();
    const interval = setInterval(refresh, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    function handleClickOutside(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [open]);

  const total = (summary?.newMentions ?? 0) + (summary?.newDms ?? 0);

  return (
    <div className="notification-bell" ref={rootRef}>
      <button
        type="button"
        className="notification-bell-button"
        onClick={() => setOpen((o) => !o)}
        aria-label={total > 0 ? `${total} new notification${total === 1 ? "" : "s"}` : "Notifications"}
      >
        <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
          <path
            fill="currentColor"
            d="M12 2a6 6 0 0 0-6 6v3.09c0 .5-.16.98-.46 1.38L4 15v1h16v-1l-1.54-2.53a2.5 2.5 0 0 1-.46-1.38V8a6 6 0 0 0-6-6Zm0 20a2.5 2.5 0 0 0 2.45-2h-4.9A2.5 2.5 0 0 0 12 22Z"
          />
        </svg>
        {total > 0 && <span className="notification-bell-badge">{total > 9 ? "9+" : total}</span>}
      </button>
      {open && (
        <div className="notification-bell-dropdown">
          {total === 0 ? (
            <p className="muted">No new mentions or DMs.</p>
          ) : (
            <>
              {summary!.newMentions > 0 && (
                <button
                  type="button"
                  className="notification-bell-row"
                  onClick={() => {
                    setOpen(false);
                    onOpenTab("Mentions");
                  }}
                >
                  {summary!.newMentions} new mention{summary!.newMentions === 1 ? "" : "s"}
                </button>
              )}
              {summary!.newDms > 0 && (
                <button
                  type="button"
                  className="notification-bell-row"
                  onClick={() => {
                    setOpen(false);
                    onOpenTab("DMs");
                  }}
                >
                  {summary!.newDms} new DM{summary!.newDms === 1 ? "" : "s"}
                </button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
