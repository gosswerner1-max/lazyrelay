// Pure mapping functions between a scheduled_posts row and a Google Calendar
// event body -- kept free of any I/O so the mapping logic itself is
// unit-testable without a database or a live API call, same philosophy as
// recurringScheduler.ts's computeOccurrencesInWindow().

export interface ScheduledPostForCalendar {
  id: string;
  content: string;
  scheduled_for: string | null; // ISO timestamp
  platform_label: string | null; // e.g. "Instagram" -- for the title prefix
}

export interface CalendarEventBody {
  summary: string;
  description: string;
  start: { dateTime: string; timeZone: string };
  end: { dateTime: string; timeZone: string };
}

const EVENT_DURATION_MINUTES = 15;

/** First line of the post content, trimmed to a sane title length -- the
 *  full content always goes in the event description, this is just what's
 *  legible in a cramped calendar cell. */
function summaryFromContent(content: string, platformLabel: string | null): string {
  const firstLine = content.split("\n")[0]?.trim() || content.trim();
  const truncated = firstLine.length > 80 ? `${firstLine.slice(0, 77)}...` : firstLine;
  return platformLabel ? `[${platformLabel}] ${truncated}` : truncated;
}

/** Builds the Calendar API event body for a scheduled_posts row. Events are
 *  always timed (never all-day) -- scheduled_for carries a real time of day
 *  that an all-day event would silently discard. Given a fixed short
 *  duration rather than reading any "end time" concept, since scheduled
 *  posts don't have one. */
export function postToCalendarEvent(post: ScheduledPostForCalendar): CalendarEventBody | null {
  if (!post.scheduled_for) return null;
  const start = new Date(post.scheduled_for);
  const end = new Date(start.getTime() + EVENT_DURATION_MINUTES * 60_000);
  return {
    summary: summaryFromContent(post.content, post.platform_label),
    description: post.content,
    start: { dateTime: start.toISOString(), timeZone: "UTC" },
    end: { dateTime: end.toISOString(), timeZone: "UTC" },
  };
}

export interface CalendarEventForPost {
  id: string;
  summary?: string;
  description?: string;
  start?: { dateTime?: string; date?: string };
  updated?: string;
  status?: string; // Google's own event status: "confirmed" | "cancelled" | "tentative"
}

export interface MappedFromCalendar {
  content: string;
  scheduledFor: string | null;
  googleUpdatedAt: string | null;
}

/** Maps a Calendar API event back into the fields a scheduled_posts row can
 *  accept. Prefers description (the full content) over summary (which may
 *  carry a truncated "[Platform] ..." prefix LazyRelay itself added) -- for
 *  an event created directly in Calendar with no description, summary is
 *  the only content available, so it's the fallback, not the default. */
export function calendarEventToPost(event: CalendarEventForPost): MappedFromCalendar {
  const content = (event.description?.trim() || event.summary?.trim() || "").trim();
  const scheduledFor = event.start?.dateTime ?? (event.start?.date ? new Date(event.start.date).toISOString() : null);
  return {
    content,
    scheduledFor,
    googleUpdatedAt: event.updated ?? null,
  };
}
