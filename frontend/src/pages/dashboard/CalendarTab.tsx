// The "Calendar" tab — extracted verbatim from the original single-file Dashboard.tsx
// (split 2026-09-25, pure mechanical move: same JSX, same handlers, same
// state — nothing added, removed, or reworded). State and handlers still
// live in one place (useDashboardState.tsx, called once by Dashboard.tsx)
// and reach this file through DashboardContext.

import { DndContext, type DragEndEvent } from "@dnd-kit/core";
import { type SocialAccount, type ScheduledPost } from "../../lib/api";
import { RelaySignal } from "../../components/RelaySignal";
import { PlatformIcon } from "../../components/PlatformIcon";
import { AccountPicker } from "../../components/AccountPicker";
import { DateTimePicker, TimeOfDayPicker } from "../../components/DateTimePicker";
import { Popover } from "../../components/Popover";
import { PostErrorDetail } from "../../components/PostErrorDetail";
import { localDateKey, accountMatchesBrand, localTimeKey, WEEKDAY_LABELS } from "./dashboardHelpers";
import { MiniMonthPicker, BrandFilterSelect, CalendarDayCell } from "./dashboardComponents";
import { useDashboard } from "./DashboardContext";

export function CalendarTab() {
  const {
    accounts,
    posts,
    gcalStatus,
    gcalConnecting,
    sharingProofId,
    setTab,
    brandFilter,
    setBrandFilter,
    approvingId,
    reschedulingId,
    pauseResumeId,
    scheduleTimezone,
    calendarMonth,
    setCalendarMonth,
    selectedDay,
    setSelectedDay,
    calendarViewMode,
    setCalendarViewMode,
    calendarWeekStart,
    setCalendarWeekStart,
    isMobile,
    dayPopoverAnchor,
    setDayPopoverAnchor,
    eventPopover,
    eventPopoverPanel,
    setEventPopoverPanel,
    calendarSearch,
    setCalendarSearch,
    createMenuOpen,
    setCreateMenuOpen,
    syncedOnlyFilter,
    setSyncedOnlyFilter,
    openDayPopover,
    openEventPopover,
    closeEventPopover,
    handleReschedulePostTo,
    handleDuplicatePostTo,
    planContent,
    setPlanContent,
    planMediaUrl,
    planMediaUploading,
    planBusy,
    planAccountIds,
    planTime,
    setPlanTime,
    promotingPlanId,
    handleEditDraft,
    handleApprove,
    handlePostExistingNow,
    handleTogglePause,
    handlePlanMediaFile,
    togglePlanAccount,
    handleAddPlanItem,
    handlePromotePlanItem,
    handleDelete,
    handleConnectGoogleCalendar,
    handleShareProof,
  } = useDashboard();

  const year = calendarMonth.getFullYear();
  const month = calendarMonth.getMonth();
  const firstOfMonth = new Date(year, month, 1);
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const leadingBlanks = firstOfMonth.getDay();
  const todayKey = localDateKey(new Date().toISOString());
  // Search (2026-08-30) — filters posts/ideas by content substring,
  // applied alongside the existing brand filter rather than
  // replacing it, so the two narrow the view together.
  const searchLower = calendarSearch.trim().toLowerCase();

  // Only sees whatever's currently loaded in `posts` — bounded to
  // Upcoming plus the most recent History page (see
  // GET /scheduled-posts) unless the customer has clicked "Load
  // more" on the History tab. A month further back than that won't
  // show its older posted/failed posts here; acceptable for now
  // since Calendar is mainly used for near-term planning, not a
  // full historical archive.
  const postsByDay: Record<string, ScheduledPost[]> = {};
  // A draft anchored to a day via planned_date (migration 0059,
  // 2026-08-20) — a content idea for that day, not yet a real post.
  // Kept in its own map (not merged into postsByDay) so the
  // day popover can show "Scheduled" and "Planned" as clearly
  // separate sections rather than one ambiguous list.
  const plansByDay: Record<string, ScheduledPost[]> = {};
  for (const p of posts) {
    if (searchLower && !p.content.toLowerCase().includes(searchLower)) continue;
    if (p.status === "draft") {
      // An undated draft (no planned_date) is managed from the Posts
      // tab's Upcoming list only, same as before this feature.
      if (!p.planned_date) continue;
      (plansByDay[p.planned_date] ??= []).push(p);
      continue;
    }
    if (!p.scheduled_for) continue;
    if (!accountMatchesBrand(accounts.find((a) => a.id === p.social_account_id), brandFilter)) continue;
    if (syncedOnlyFilter && !p.google_event_id) continue;
    const key = localDateKey(p.scheduled_for);
    (postsByDay[key] ??= []).push(p);
  }

  const cells: { day: number | null; key: string | null }[] = [];
  for (let i = 0; i < leadingBlanks; i++) cells.push({ day: null, key: null });
  for (let d = 1; d <= daysInMonth; d++) {
    cells.push({ day: d, key: `${year}-${String(month + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}` });
  }

  const dayPosts = selectedDay ? (postsByDay[selectedDay] ?? []) : [];
  const dayPlans = selectedDay ? (plansByDay[selectedDay] ?? []) : [];
  const hasItemsKeys = new Set<string>([...Object.keys(postsByDay), ...Object.keys(plansByDay)]);

  // One line per post/planned-item — a real scheduled post reads as
  // "9:00 instagram — launch teaser" and a planned idea (no
  // time/platform yet) reads as "Idea — launch teaser".
  function eventLineLabel(p: ScheduledPost): string {
    const snippet = p.content.length > 34 ? `${p.content.slice(0, 34)}…` : p.content;
    if (p.status === "draft") return `Idea — ${snippet}`;
    const account = accounts.find((a) => a.id === p.social_account_id);
    const time = p.scheduled_for ? new Date(p.scheduled_for).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }) : "";
    return [time, account?.platform].filter(Boolean).join(" ") + ` — ${snippet}`;
  }

  function dayKey(d: Date): string {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }

  // Week view (time-block grid) — a real week on desktop, but a
  // 7-column hour grid genuinely doesn't fit a real phone (checked at
  // 375px, 2026-08-20: columns render 26-31px wide, present in the
  // DOM but visually unreadable). Mobile shows one day at a time
  // instead — the same pattern real calendar apps use at this width
  // — rather than a shrunk, unreadable version of the week grid.
  // Only real scheduled posts can be placed on an hour axis (a
  // planned idea has no time yet, so it stays month-view-only until
  // promoted). Rows exist only for hours that actually have
  // something in the visible range — Werner's own reference draws a
  // full 24-row grid as wasted space, so this doesn't either.
  const timeblockDayCount = isMobile ? 1 : 7;
  const weekDays: { date: Date; key: string }[] = [];
  for (let i = 0; i < timeblockDayCount; i++) {
    const d = new Date(calendarWeekStart.getFullYear(), calendarWeekStart.getMonth(), calendarWeekStart.getDate() + i);
    weekDays.push({ date: d, key: dayKey(d) });
  }
  const activeHours = new Set<number>();
  for (const { key } of weekDays) {
    for (const p of postsByDay[key] ?? []) {
      if (p.scheduled_for) activeHours.add(new Date(p.scheduled_for).getHours());
    }
  }
  const sortedHours = [...activeHours].sort((a, b) => a - b);

  const weekEnd = weekDays[weekDays.length - 1].date;
  const weekRangeLabel = isMobile
    ? weekDays[0].date.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })
    : weekDays[0].date.getMonth() === weekEnd.getMonth()
      ? `${weekDays[0].date.toLocaleDateString(undefined, { month: "long", day: "numeric" })} – ${weekEnd.toLocaleDateString(undefined, { day: "numeric", year: "numeric" })}`
      : `${weekDays[0].date.toLocaleDateString(undefined, { month: "short", day: "numeric" })} – ${weekEnd.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}`;
  const timeblockColumns = `64px repeat(${weekDays.length}, minmax(0, 1fr))`;

  // Agenda list for the month view on mobile (2026-08-30) — replaces
  // the old colored-dots-only cells, which lost all information at
  // phone width. One section per day-with-something, matching
  // Google Calendar's own "Schedule" view.
  const agendaDays = cells.filter((c) => c.key && ((postsByDay[c.key]?.length ?? 0) + (plansByDay[c.key]?.length ?? 0) > 0));

  return (
    <section className="calendar-layout">
      <aside className="calendar-sidebar">
        <div className="calendar-create-menu">
          <button type="button" onClick={() => setCreateMenuOpen((v) => !v)}>
            + Create
          </button>
          {createMenuOpen && (
            <div className="calendar-create-menu-list">
              <button type="button" onClick={() => { setCreateMenuOpen(false); setTab("Posts"); }}>
                Scheduled post
              </button>
              <button type="button" onClick={() => { setCreateMenuOpen(false); setTab("Posts"); }}>
                Recurring schedule
              </button>
              <button
                type="button"
                onClick={(e) => {
                  setCreateMenuOpen(false);
                  openDayPopover(todayKey, e.currentTarget);
                }}
              >
                Idea
              </button>
            </div>
          )}
        </div>

        <MiniMonthPicker
          month={calendarMonth}
          onPrev={() => setCalendarMonth(new Date(year, month - 1, 1))}
          onNext={() => setCalendarMonth(new Date(year, month + 1, 1))}
          onSelectDay={(key, el) => openDayPopover(key, el)}
          selectedKey={selectedDay}
          todayKey={todayKey}
          hasItemsKeys={hasItemsKeys}
        />

        <input
          type="search"
          className="calendar-search"
          placeholder="Search posts…"
          value={calendarSearch}
          onChange={(e) => setCalendarSearch(e.target.value)}
        />

        <BrandFilterSelect accounts={accounts} value={brandFilter} onChange={setBrandFilter} />

        {/* Which Google account is connected, shown right here instead
            of only buried in Settings (Werner, 2026-08-30) — clicking
            it filters the grid to posts that actually reached that
            calendar (google_event_id set), not just everything. */}
        {gcalStatus ? (
          <button
            type="button"
            className={`calendar-gcal-indicator${syncedOnlyFilter ? " calendar-gcal-indicator-active" : ""}`}
            onClick={() => setSyncedOnlyFilter((v) => !v)}
            title={syncedOnlyFilter ? "Showing only posts synced to Google Calendar — click to show all" : "Click to show only posts synced to Google Calendar"}
          >
            📅 {gcalStatus.connected_email ? `Connected as ${gcalStatus.connected_email}` : "Google Calendar connected"}
          </button>
        ) : gcalStatus === null ? (
          <button type="button" className="calendar-gcal-indicator" onClick={handleConnectGoogleCalendar} disabled={gcalConnecting}>
            📅 {gcalConnecting ? "Connecting..." : "Connect Google Calendar"}
          </button>
        ) : null}
      </aside>

      <div className="calendar-main">
        <div className="calendar-header">
          <button
            type="button"
            className="btn-outline"
            onClick={() => {
              if (calendarViewMode === "compact") {
                setCalendarMonth(new Date(year, month - 1, 1));
              } else {
                // Mobile Week view shows one day, so Prev/Next steps by
                // a day instead of a full week — same anchor state,
                // just a different step size.
                const step = isMobile ? 1 : 7;
                setCalendarWeekStart(new Date(calendarWeekStart.getFullYear(), calendarWeekStart.getMonth(), calendarWeekStart.getDate() - step));
              }
              setSelectedDay(null);
              setDayPopoverAnchor(null);
            }}
          >
            &larr; Prev
          </button>
          <h2>{calendarViewMode === "compact" ? firstOfMonth.toLocaleDateString(undefined, { month: "long", year: "numeric" }) : weekRangeLabel}</h2>
          <button
            type="button"
            className="btn-outline"
            onClick={() => {
              if (calendarViewMode === "compact") {
                setCalendarMonth(new Date(year, month + 1, 1));
              } else {
                const step = isMobile ? 1 : 7;
                setCalendarWeekStart(new Date(calendarWeekStart.getFullYear(), calendarWeekStart.getMonth(), calendarWeekStart.getDate() + step));
              }
              setSelectedDay(null);
              setDayPopoverAnchor(null);
            }}
          >
            Next &rarr;
          </button>
        </div>
        <div className="calendar-view-toggle">
          {/* Internal state values (compact/calendar) are unchanged —
              only the customer-facing labels swapped, per Werner's own
              mental model: "Calendar view" for the familiar month grid,
              "Week view" for the time-block week grid. Renaming the
              state itself risked missing a reference somewhere; this
              doesn't. */}
          <button
            type="button"
            className={calendarViewMode === "compact" ? "calendar-view-toggle-active" : ""}
            onClick={() => setCalendarViewMode("compact")}
          >
            Calendar view
          </button>
          <button
            type="button"
            className={calendarViewMode === "calendar" ? "calendar-view-toggle-active" : ""}
            onClick={() => setCalendarViewMode("calendar")}
          >
            Week view
          </button>
        </div>

        {calendarViewMode === "calendar" ? (
          <div className="calendar-timeblock">
            <div className="calendar-timeblock-header" style={{ gridTemplateColumns: timeblockColumns }}>
              <div className="calendar-timeblock-time-col" />
              {weekDays.map(({ date, key }) => (
                <div key={key} className={`calendar-timeblock-day-header${key === todayKey ? " calendar-timeblock-day-header-today" : ""}`}>
                  <span className="calendar-timeblock-day-name">{date.toLocaleDateString(undefined, { weekday: "short" })}</span>
                  <span className="calendar-timeblock-day-num">{date.getDate()}</span>
                </div>
              ))}
            </div>
            {sortedHours.length === 0 ? (
              <p className="empty">Nothing scheduled this week.</p>
            ) : (
              sortedHours.map((hour) => (
                <div key={hour} className="calendar-timeblock-row" style={{ gridTemplateColumns: timeblockColumns }}>
                  <div className="calendar-timeblock-time-col">
                    {new Date(2000, 0, 1, hour).toLocaleTimeString(undefined, { hour: "numeric" })}
                  </div>
                  {weekDays.map(({ key }) => {
                    const items = (postsByDay[key] ?? []).filter((p) => p.scheduled_for && new Date(p.scheduled_for).getHours() === hour);
                    return (
                      <div key={key} className="calendar-timeblock-cell">
                        {items.map((p) => (
                          <span
                            key={p.id}
                            role="button"
                            tabIndex={0}
                            className={`calendar-event-row calendar-event-row-${p.status}`}
                            onClick={(e) => openEventPopover(p, e.currentTarget)}
                          >
                            {eventLineLabel(p)}
                          </span>
                        ))}
                      </div>
                    );
                  })}
                </div>
              ))
            )}
          </div>
        ) : isMobile ? (
          <div className="calendar-agenda-list">
            {agendaDays.length === 0 ? (
              <p className="empty">Nothing scheduled this month.</p>
            ) : (
              agendaDays.map((c) => {
                const items = [...(postsByDay[c.key!] ?? []), ...(plansByDay[c.key!] ?? [])];
                return (
                  <div key={c.key} className="calendar-agenda-day">
                    <div className="calendar-agenda-day-heading">
                      {new Date(`${c.key}T00:00:00`).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}
                    </div>
                    {items.map((p) => (
                      <button
                        type="button"
                        key={p.id}
                        className={`calendar-agenda-row calendar-event-row-${p.status}`}
                        onClick={(e) => openEventPopover(p, e.currentTarget)}
                      >
                        {eventLineLabel(p)}
                      </button>
                    ))}
                  </div>
                );
              })
            )}
          </div>
        ) : (
          <DndContext
            onDragEnd={(event: DragEndEvent) => {
              const { active, over } = event;
              if (!over) return;
              const overId = String(over.id);
              if (!overId.startsWith("day:")) return;
              const targetDayKey = overId.slice(4);
              const post = posts.find((p) => p.id === String(active.id));
              // Same guards as the reschedule route itself (pending-
              // only, must have a time to preserve) -- a chip for
              // anything else is never draggable in the first place,
              // this is just defense in depth.
              if (!post || post.status !== "pending" || !post.scheduled_for) return;
              if (localDateKey(post.scheduled_for) === targetDayKey) return;
              handleReschedulePostTo(post.id, targetDayKey, localTimeKey(post.scheduled_for));
            }}
          >
            <div className="calendar-grid">
              {WEEKDAY_LABELS.map((w) => (
                <div key={w} className="calendar-weekday">
                  {w}
                </div>
              ))}
              {cells.map((c, i) =>
                c.day === null ? (
                  <div key={`blank-${i}`} className="calendar-cell calendar-cell-blank" />
                ) : (
                  <CalendarDayCell
                    key={c.key}
                    cellKey={c.key!}
                    day={c.day}
                    isToday={c.key === todayKey}
                    isSelected={c.key === selectedDay}
                    dayItems={[...(postsByDay[c.key!] ?? []), ...(plansByDay[c.key!] ?? [])]}
                    eventLineLabel={eventLineLabel}
                    onOpenDay={openDayPopover}
                    onOpenEvent={openEventPopover}
                  />
                ),
              )}
            </div>
          </DndContext>
        )}
      </div>

      {selectedDay && dayPopoverAnchor && (
        <Popover
          anchorRect={dayPopoverAnchor}
          onClose={() => {
            setSelectedDay(null);
            setDayPopoverAnchor(null);
          }}
          className="calendar-day-popover"
        >
          <div className="popover-header">
            <h3>{new Date(`${selectedDay}T00:00:00`).toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}</h3>
            <button
              type="button"
              className="popover-close"
              onClick={() => {
                setSelectedDay(null);
                setDayPopoverAnchor(null);
              }}
            >
              &times;
            </button>
          </div>

          {/* Planned section (add-form + existing plan items) comes
              FIRST, before the scheduled-posts list — Werner's own
              catch: on a busy day with many scheduled posts, the
              add-a-note form used to sit below all of them, so
              adding a new idea meant scrolling past everything
              already scheduled just to reach it every time. */}
          <h4 className="calendar-plans-heading">Planned</h4>
          {dayPlans.length === 0 ? (
            <p className="empty">No planned ideas yet.</p>
          ) : (
            <ul className="post-list">
              {dayPlans.map((p) => {
                const plannedAccounts = (p.planned_account_ids ?? [])
                  .map((id) => accounts.find((a) => a.id === id))
                  .filter((a): a is SocialAccount => !!a);
                const isPromoting = promotingPlanId === p.id;
                return (
                  <li key={p.id} className="post-status-draft">
                    {p.media_url && <img className="media-list-thumb" src={p.media_url} alt="Media attached to this planned post" />}
                    <div className="post-content">{p.content}</div>
                    {plannedAccounts.length > 0 && (
                      <div className="post-platform">
                        {plannedAccounts.map((a) => (
                          <PlatformIcon key={a.id} platform={a.platform} size={14} />
                        ))}
                        {p.scheduled_for && (
                          <span className="calendar-plan-time">
                            {new Date(p.scheduled_for).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}
                          </span>
                        )}
                      </div>
                    )}
                    <div className="post-meta">
                      <label className="account-checkbox">
                        <input type="checkbox" disabled={isPromoting} onChange={() => handlePromotePlanItem(p)} />
                        {isPromoting ? "Adding to scheduler..." : "Add to scheduler"}
                      </label>
                      <button className="btn-outline" disabled={isPromoting} onClick={() => handleDelete(p.id, false)}>
                        Delete
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
          <form
            className="calendar-plan-form"
            onSubmit={(e) => {
              e.preventDefault();
              handleAddPlanItem(selectedDay);
            }}
          >
            <textarea
              placeholder="Add a note or content idea for this day..."
              value={planContent}
              onChange={(e) => setPlanContent(e.target.value)}
            />
            <label className="calendar-plan-platform-label">
              Platform(s) — optional, pick now to schedule with one tick later
              <AccountPicker accounts={accounts} selectedIds={planAccountIds} onToggle={togglePlanAccount} />
            </label>
            {planAccountIds.length > 0 && (
              <TimeOfDayPicker time={planTime} onChange={setPlanTime} timezoneLabel={scheduleTimezone} />
            )}
            <div className="calendar-plan-form-actions">
              <label className="btn-outline calendar-plan-file-label">
                {planMediaUploading ? "Uploading..." : planMediaUrl ? "File attached" : "Attach a file"}
                <input
                  type="file"
                  hidden
                  disabled={planMediaUploading}
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) handlePlanMediaFile(file);
                  }}
                />
              </label>
              <button
                type="submit"
                disabled={planBusy || planMediaUploading || !planContent.trim() || (planAccountIds.length > 0 && !planTime)}
              >
                {planBusy ? "Adding..." : "Add to planner"}
              </button>
            </div>
          </form>

          <h4 className="calendar-plans-heading">Scheduled</h4>
          {dayPosts.length === 0 ? (
            <p className="empty">Nothing scheduled this day.</p>
          ) : (
            <ul className="post-list">
              {dayPosts.map((p) => (
                <li key={p.id} className={`post-status-${p.status}`}>
                  <button
                    type="button"
                    className="calendar-day-popover-post-link"
                    onClick={(e) => openEventPopover(p, e.currentTarget)}
                  >
                    {eventLineLabel(p)}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Popover>
      )}

      {eventPopover && (() => {
        const p = eventPopover.post;
        const account = accounts.find((a) => a.id === p.social_account_id);
        const result = p.post_results?.[0];
        return (
          <Popover anchorRect={eventPopover.anchor} onClose={closeEventPopover} className="calendar-event-popover">
            <div className="popover-header">
              <div className="popover-header-actions">
                {p.status === "draft" && (
                  <button
                    type="button"
                    className="popover-icon-btn"
                    title="Edit"
                    onClick={() => {
                      handleEditDraft(p);
                      closeEventPopover();
                    }}
                  >
                    &#9998;
                  </button>
                )}
                {p.status !== "posting" && (
                  <button
                    type="button"
                    className="popover-icon-btn"
                    title={p.status === "pending" || p.status === "needs_approval" ? "Cancel" : "Delete"}
                    onClick={() => {
                      handleDelete(p.id, p.status !== "pending" && p.status !== "needs_approval");
                      closeEventPopover();
                    }}
                  >
                    &#128465;
                  </button>
                )}
                {p.status === "pending" && (
                  <button
                    type="button"
                    className="popover-icon-btn"
                    title="More options"
                    onClick={() => setEventPopoverPanel(eventPopoverPanel === "menu" ? null : "menu")}
                  >
                    &#8942;
                  </button>
                )}
              </div>
              <button type="button" className="popover-close" onClick={closeEventPopover}>
                &times;
              </button>
            </div>

            {/* Inline, not an absolutely-positioned dropdown (2026-08-30
                fix) — a floating menu here got silently clipped by
                .popover-panel's own overflow-y: auto, which per the CSS
                overflow spec forces overflow-x to also stop being
                "visible" the moment overflow-y isn't, so a menu wide
                enough to extend past the panel's edge was cut off no
                matter which side it was anchored to. An inline expanding
                section sidesteps the whole problem. */}
            {eventPopoverPanel === "menu" && p.status === "pending" && (
              <div className="popover-kebab-menu">
                <button type="button" onClick={() => setEventPopoverPanel("move")}>
                  Move to another day...
                </button>
                {!p.paused_at && (
                  <button
                    type="button"
                    disabled={reschedulingId === p.id}
                    onClick={() => {
                      handlePostExistingNow(p.id);
                      setEventPopoverPanel(null);
                    }}
                  >
                    Post now
                  </button>
                )}
                <button
                  type="button"
                  disabled={pauseResumeId === p.id}
                  onClick={() => {
                    handleTogglePause(p.id, Boolean(p.paused_at));
                    setEventPopoverPanel(null);
                  }}
                >
                  {p.paused_at ? "Resume" : "Pause"}
                </button>
                <button type="button" onClick={() => setEventPopoverPanel("duplicate")}>
                  Duplicate to another day...
                </button>
              </div>
            )}

            <div className="popover-event-body">
              <div className="popover-event-title">
                {account && <PlatformIcon platform={account.platform} size={16} />}
                <span>{account?.display_name ?? account?.platform_account_id ?? (p.status === "draft" ? "Idea" : "")}</span>
              </div>
              {p.scheduled_for && (
                <div className="popover-event-time">
                  {new Date(p.scheduled_for).toLocaleString(undefined, { weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" })}
                </div>
              )}
              <div className="popover-event-content">{p.content}</div>
              <span className={`status-badge status-${p.status}${p.paused_at ? " status-paused" : ""}`}>
                {p.paused_at ? "Paused" : p.status === "needs_approval" ? "Needs approval" : p.status}
              </span>
              {result &&
                (result.verified_live ? (
                  <span className="verified">
                    <RelaySignal size={14} pulsing /> Confirmed live
                  </span>
                ) : (
                  <PostErrorDetail errorMessage={result.error_message} platform={account?.platform} />
                ))}
              {result?.verified_live && (
                <button className="btn-outline" disabled={sharingProofId === p.id} onClick={() => handleShareProof(p.id)}>
                  {sharingProofId === p.id ? "..." : "Share proof"}
                </button>
              )}
              {p.status === "needs_approval" && (
                <button className="btn-outline" disabled={approvingId === p.id} onClick={() => handleApprove(p.id)}>
                  {approvingId === p.id ? "Approving..." : "Approve"}
                </button>
              )}
            </div>

            {eventPopoverPanel === "move" && (
              <div className="popover-subpanel">
                <p className="section-note">Move to a new day and time:</p>
                <DateTimePicker date="" time="" onApply={(date, time) => handleReschedulePostTo(p.id, date, time)} timezoneLabel={scheduleTimezone} />
              </div>
            )}
            {eventPopoverPanel === "duplicate" && (
              <div className="popover-subpanel">
                <p className="section-note">Duplicate to a new day and time:</p>
                <DateTimePicker date="" time="" onApply={(date, time) => handleDuplicatePostTo(p.id, date, time)} timezoneLabel={scheduleTimezone} />
              </div>
            )}
          </Popover>
        );
      })()}
    </section>
  );
}
