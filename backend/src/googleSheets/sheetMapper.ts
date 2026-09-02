// Pure mapping from a scheduled_posts row (joined with its social account)
// to a spreadsheet row -- kept free of any I/O, same philosophy as
// googleCalendar/eventMapper.ts.

export interface ScheduledPostForSheet {
  content: string;
  scheduled_for: string; // ISO timestamp -- caller has already filtered out null
  status: string;
  platform_label: string | null;
  account_label: string | null;
}

export const SHEET_TAB_TITLE = "Content Calendar";
export const HEADER_ROW = ["Date", "Time", "Platform", "Account", "Content", "Status", "Link"];

const STATUS_LABELS: Record<string, string> = {
  pending: "Pending",
  posting: "Posting",
  posted: "Posted",
  failed: "Failed",
  needs_approval: "Needs approval",
};

function statusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status;
}

/** First line of the post content, trimmed to a sane cell length -- a
 *  spreadsheet cell can hold the full text, but a one-line preview is what's
 *  actually legible when scanning a column of rows. */
function contentPreview(content: string): string {
  const firstLine = content.split("\n")[0]?.trim() || content.trim();
  return firstLine.length > 120 ? `${firstLine.slice(0, 117)}...` : firstLine;
}

/** Builds the non-link cells of one data row (columns A-F). Written with
 *  valueInputOption=RAW (see outboundSync.ts) specifically so customer-
 *  authored content starting with +/-/@ is never misparsed as a formula --
 *  a real bug hit and fixed the hard way in the unrelated Lazy Download
 *  Wedding Planner spreadsheet work, worth not repeating here. */
export function postToSheetRow(post: ScheduledPostForSheet): string[] {
  const date = new Date(post.scheduled_for);
  return [
    date.toISOString().slice(0, 10),
    date.toISOString().slice(11, 16),
    post.platform_label ?? "",
    post.account_label ?? "",
    contentPreview(post.content),
    statusLabel(post.status),
  ];
}

/** The link cell (column G), built separately as its own USER_ENTERED
 *  write -- this is the one column whose content LazyRelay always fully
 *  controls (never customer text), so a HYPERLINK formula is safe here even
 *  though RAW is required for every other column. */
export function sheetLinkFormula(frontendUrl: string): string {
  return `=HYPERLINK("${frontendUrl}","Open in LazyRelay")`;
}
