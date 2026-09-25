// Small module-level components that used to sit at the top of Dashboard.tsx,
// needed by more than one of the files it was split into (2026-09-25). Moved
// verbatim — the only change is the added `export`.

import { type CSSProperties } from "react";
import { useDraggable, useDroppable } from "@dnd-kit/core";
import { type SocialAccount, type ScheduledPost, type Triage } from "../../lib/api";
import { TRIAGE_CATEGORY_LABELS, UNBRANDED_FILTER_VALUE, WEEKDAY_LABELS } from "./dashboardHelpers";

export function TriageBadge({ triage }: { triage?: Triage | null }) {
  if (!triage?.needsAttention) return null;
  return (
    <span className="triage-badge" title={triage.reason}>
      {TRIAGE_CATEGORY_LABELS[triage.category] ?? "Needs attention"}
    </span>
  );
}

// Multi-brand filtering (2026-08-08) — one shared dropdown, rendered in
// every view a brand filter applies to (Overview, Posts, Calendar,
// Analytics, Mentions, DMs), all bound to the same brandFilter state so
// switching tabs doesn't lose the customer's current filter. Hidden
// entirely when there's nothing to filter by (0-1 connected accounts, or
// every account shares one unlabeled bucket) rather than showing a
// single-option dropdown that does nothing.
export function BrandFilterSelect({ accounts, value, onChange }: { accounts: SocialAccount[]; value: string; onChange: (v: string) => void }) {
  const labels = [...new Set(accounts.map((a) => a.brand_label?.trim()).filter((l): l is string => !!l))].sort();
  const hasUnbranded = accounts.some((a) => !a.brand_label?.trim());
  if (labels.length === 0) return null;
  return (
    <select className="brand-filter-select" value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">All brands</option>
      {labels.map((l) => (
        <option key={l} value={l}>
          {l}
        </option>
      ))}
      {hasUnbranded && <option value={UNBRANDED_FILTER_VALUE}>Unbranded</option>}
    </select>
  );
}

// Compact month picker for the Calendar tab's sidebar (2026-08-30) —
// mirrors the main grid's own `calendarMonth` rather than paginating
// independently, so the two views can never show different months at
// once. `hasItemsKeys` gets a small dot under any day that has a post or
// planned idea, same signal Google's own mini-picker equivalent gives.
export function MiniMonthPicker({
  month,
  onPrev,
  onNext,
  onSelectDay,
  selectedKey,
  todayKey,
  hasItemsKeys,
}: {
  month: Date;
  onPrev: () => void;
  onNext: () => void;
  onSelectDay: (key: string, el: HTMLElement) => void;
  selectedKey: string | null;
  todayKey: string;
  hasItemsKeys: Set<string>;
}) {
  const year = month.getFullYear();
  const m = month.getMonth();
  const daysInMonth = new Date(year, m + 1, 0).getDate();
  const leadingBlanks = new Date(year, m, 1).getDay();
  const cells: { day: number | null; key: string | null }[] = [];
  for (let i = 0; i < leadingBlanks; i++) cells.push({ day: null, key: null });
  for (let d = 1; d <= daysInMonth; d++) {
    cells.push({ day: d, key: `${year}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}` });
  }
  return (
    <div className="calendar-mini-month">
      <div className="calendar-mini-month-header">
        <button type="button" className="btn-outline" onClick={onPrev}>
          &larr;
        </button>
        <span>{month.toLocaleDateString(undefined, { month: "long", year: "numeric" })}</span>
        <button type="button" className="btn-outline" onClick={onNext}>
          &rarr;
        </button>
      </div>
      <div className="calendar-mini-month-grid">
        {WEEKDAY_LABELS.map((w) => (
          <div key={w} className="calendar-mini-month-weekday">
            {w.slice(0, 1)}
          </div>
        ))}
        {cells.map((c, i) =>
          c.day === null ? (
            <div key={`blank-${i}`} />
          ) : (
            <button
              type="button"
              key={c.key}
              className={`calendar-mini-month-day${c.key === todayKey ? " calendar-mini-month-day-today" : ""}${c.key === selectedKey ? " calendar-mini-month-day-selected" : ""}${c.key && hasItemsKeys.has(c.key) ? " calendar-mini-month-day-has-items" : ""}`}
              onClick={(e) => onSelectDay(c.key!, e.currentTarget)}
            >
              {c.day}
            </button>
          ),
        )}
      </div>
    </div>
  );
}

// Draggable event chip (Phase 2, 2026-08-30) -- only a `pending` post can be
// dragged, matching the reschedule route's own status guard, so a posted/
// failed/draft/needs_approval chip renders identically to before this
// existed (useDraggable's listeners/attributes are simply omitted). A
// plain click still opens the event popover: @dnd-kit's default pointer
// sensor has its own drag-vs-click distance threshold, so this doesn't
// need any manual suppression.
export function CalendarEventChip({
  post,
  label,
  onOpen,
}: {
  post: ScheduledPost;
  label: string;
  onOpen: (post: ScheduledPost, el: HTMLElement) => void;
}) {
  const draggable = post.status === "pending";
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: post.id,
    disabled: !draggable,
  });
  const style: CSSProperties | undefined = transform
    ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)`, zIndex: 80 }
    : undefined;
  return (
    <span
      ref={setNodeRef}
      role="button"
      tabIndex={0}
      style={style}
      className={`calendar-event-row calendar-event-row-${post.status}${isDragging ? " calendar-event-row-dragging" : ""}`}
      onClick={(e) => {
        e.stopPropagation();
        onOpen(post, e.currentTarget);
      }}
      {...(draggable ? attributes : {})}
      {...(draggable ? listeners : {})}
    >
      {label}
    </span>
  );
}

// Droppable day cell (Phase 2, 2026-08-30) -- extracted from what used to
// be an inline .map() in the Calendar tab's render because @dnd-kit's
// useDroppable/useDraggable are hooks, and hooks can't be called per-
// iteration inside another component's render; each cell/chip needs to be
// its own component instance. `id` is prefixed "day:" so handleDragEnd can
// tell a day-cell drop target apart from anything else droppable added
// later without guessing from the raw key format.
export function CalendarDayCell({
  cellKey,
  day,
  isToday,
  isSelected,
  dayItems,
  eventLineLabel,
  onOpenDay,
  onOpenEvent,
}: {
  cellKey: string;
  day: number;
  isToday: boolean;
  isSelected: boolean;
  dayItems: ScheduledPost[];
  eventLineLabel: (p: ScheduledPost) => string;
  onOpenDay: (key: string, el: HTMLElement) => void;
  onOpenEvent: (post: ScheduledPost, el: HTMLElement) => void;
}) {
  const { isOver, setNodeRef } = useDroppable({ id: `day:${cellKey}` });
  const shown = dayItems.slice(0, 5);
  return (
    <div
      ref={setNodeRef}
      role="button"
      tabIndex={0}
      className={`calendar-cell${isToday ? " calendar-cell-today" : ""}${isSelected ? " calendar-cell-selected" : ""}${isOver ? " calendar-cell-drop-over" : ""}`}
      onClick={(e) => onOpenDay(cellKey, e.currentTarget)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpenDay(cellKey, e.currentTarget);
        }
      }}
    >
      <span className="calendar-cell-head">
        <span className="calendar-cell-day">{day}</span>
        {dayItems.length > 0 && (
          <button
            type="button"
            className="calendar-cell-view-day"
            onClick={(e) => {
              e.stopPropagation();
              onOpenDay(cellKey, e.currentTarget);
            }}
          >
            View day
          </button>
        )}
      </span>
      {dayItems.length > 0 && (
        <span className="calendar-cell-events">
          {shown.map((p) => (
            <CalendarEventChip key={p.id} post={p} label={eventLineLabel(p)} onOpen={onOpenEvent} />
          ))}
          {dayItems.length > shown.length && <span className="calendar-cell-more">+{dayItems.length - shown.length} more</span>}
        </span>
      )}
    </div>
  );
}
