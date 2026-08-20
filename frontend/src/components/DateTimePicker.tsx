import { useEffect, useRef, useState } from "react";

const WEEKDAY_LABELS = ["S", "M", "T", "W", "T", "F", "S"];

// A few sensible fixed windows, not tied to any one platform's real
// engagement data — LazyRelay has no post-level engagement metrics yet
// (see lib/bestTimes.ts's own header comment), so these are just quick
// picks for common posting windows, not a personalized recommendation.
const SUGGESTED_TIMES = [
  { label: "Morning", time: "09:00" },
  { label: "Midday", time: "12:00" },
  { label: "Evening", time: "18:00" },
];

function formatDisplay(date: string, time: string): string {
  if (!date) return "Pick a date and time";
  const d = new Date(`${date}T${time || "00:00"}`);
  const dateLabel = d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  if (!time) return dateLabel;
  const timeLabel = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return `${dateLabel}, ${timeLabel}`;
}

interface DateTimePickerProps {
  date: string; // "YYYY-MM-DD", or "" if unset
  time: string; // "HH:MM", or "" if unset
  onApply: (date: string, time: string) => void;
  timezoneLabel?: string;
}

/**
 * A real calendar-style date/time picker (mini month grid, a time field,
 * a few suggested-time quick picks, Cancel/Apply) — replaces the plain
 * native <input type="date"> / <input type="time"> pair in the Posts tab's
 * schedule form, per Werner's own reference screenshot, 2026-08-20. Edits
 * are staged in local state and only committed via onApply — Cancel (or
 * clicking outside) discards them, so a half-finished pick never
 * overwrites an already-valid scheduled time.
 */
export function DateTimePicker({ date, time, onApply, timezoneLabel }: DateTimePickerProps) {
  const [open, setOpen] = useState(false);
  const [draftDate, setDraftDate] = useState(date);
  const [draftTime, setDraftTime] = useState(time);
  const [viewMonth, setViewMonth] = useState(() => {
    const d = date ? new Date(`${date}T00:00:00`) : new Date();
    return new Date(d.getFullYear(), d.getMonth(), 1);
  });
  const rootRef = useRef<HTMLDivElement>(null);

  function openPicker() {
    // Re-stage from the current committed value every time it opens, so a
    // previous Cancel never leaves stale draft state behind.
    setDraftDate(date);
    setDraftTime(time);
    const anchor = date ? new Date(`${date}T00:00:00`) : new Date();
    setViewMonth(new Date(anchor.getFullYear(), anchor.getMonth(), 1));
    setOpen(true);
  }

  useEffect(() => {
    if (!open) return;
    function handleClickOutside(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [open]);

  const year = viewMonth.getFullYear();
  const month = viewMonth.getMonth();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const leadingBlanks = new Date(year, month, 1).getDay();
  const todayKey = (() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  })();
  const cells: { day: number | null; key: string | null }[] = [];
  for (let i = 0; i < leadingBlanks; i++) cells.push({ day: null, key: null });
  for (let d = 1; d <= daysInMonth; d++) {
    cells.push({ day: d, key: `${year}-${String(month + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}` });
  }

  return (
    <div className="datetime-picker" ref={rootRef}>
      <button type="button" className="datetime-picker-trigger" onClick={() => (open ? setOpen(false) : openPicker())}>
        {formatDisplay(date, time)}
      </button>
      {open && (
        <div className="datetime-picker-popup">
          <div className="datetime-picker-month-nav">
            <button type="button" className="btn-outline" onClick={() => setViewMonth(new Date(year, month - 1, 1))}>
              &larr;
            </button>
            <span>{viewMonth.toLocaleDateString(undefined, { month: "long", year: "numeric" })}</span>
            <button type="button" className="btn-outline" onClick={() => setViewMonth(new Date(year, month + 1, 1))}>
              &rarr;
            </button>
          </div>
          <div className="datetime-picker-grid">
            {WEEKDAY_LABELS.map((w, i) => (
              <div key={i} className="datetime-picker-weekday">
                {w}
              </div>
            ))}
            {cells.map((c, i) =>
              c.day === null ? (
                <div key={`blank-${i}`} />
              ) : (
                <button
                  type="button"
                  key={c.key}
                  className={`datetime-picker-day${c.key === draftDate ? " datetime-picker-day-selected" : ""}${c.key === todayKey ? " datetime-picker-day-today" : ""}`}
                  onClick={() => setDraftDate(c.key!)}
                >
                  {c.day}
                </button>
              ),
            )}
          </div>
          <label className="datetime-picker-time-label">
            Time{timezoneLabel ? ` (${timezoneLabel})` : ""}
            <input type="time" value={draftTime} onChange={(e) => setDraftTime(e.target.value)} />
          </label>
          <div className="datetime-picker-suggested">
            <span className="datetime-picker-suggested-label">Suggested time</span>
            {SUGGESTED_TIMES.map((s) => (
              <button
                type="button"
                key={s.time}
                className={`datetime-picker-suggested-chip${draftTime === s.time ? " datetime-picker-suggested-chip-active" : ""}`}
                onClick={() => setDraftTime(s.time)}
              >
                {s.label}
              </button>
            ))}
          </div>
          <div className="datetime-picker-actions">
            <button type="button" className="btn-outline" onClick={() => setOpen(false)}>
              Cancel
            </button>
            <button
              type="button"
              disabled={!draftDate || !draftTime}
              onClick={() => {
                onApply(draftDate, draftTime);
                setOpen(false);
              }}
            >
              Apply
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
