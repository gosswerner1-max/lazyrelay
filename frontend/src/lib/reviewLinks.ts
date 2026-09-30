// Client review links (backend 0107): types and small helpers shared by the owner's Settings
// section, the feedback thread on posts, and the public review page.

export interface ReviewLink {
  id: string;
  token: string;
  label: string | null;
  brandLabel: string | null;
  expiresAt: string;
  lastViewedAt: string | null;
  createdAt: string;
  status: "active" | "expired" | "revoked";
}

export interface ReviewLinkList {
  maxLinks: number;
  links: ReviewLink[];
}

export interface ReviewComment {
  id?: string;
  authorKind: "reviewer" | "owner";
  authorName: string;
  kind: "comment" | "approved" | "changes_requested" | "updated";
  body: string | null;
  createdAt: string;
}

export type ReviewPostState = "waiting" | "changes_requested" | "approved";

export interface PublicReviewPost {
  id: string;
  content: string;
  mediaUrl: string | null;
  mediaUrls: string[];
  scheduledFor: string | null;
  platform: string | null;
  accountName: string | null;
  state: ReviewPostState;
  options: Record<string, unknown>;
  comments: ReviewComment[];
}

export interface PublicReview {
  businessName: string | null;
  label: string | null;
  expiresAt: string;
  posts: PublicReviewPost[];
}

/** The address a client opens. Built from the page's own origin so it is right on any domain. */
export function reviewUrl(token: string, origin: string): string {
  return `${origin.replace(/\/$/, "")}/review/${token}`;
}

export function describeLink(l: Pick<ReviewLink, "status" | "expiresAt" | "lastViewedAt">, now: Date = new Date()): string {
  if (l.status === "revoked") return "Removed";
  if (l.status === "expired") return "Expired";
  const days = Math.max(0, Math.ceil((new Date(l.expiresAt).getTime() - now.getTime()) / 86_400_000));
  const opened = l.lastViewedAt ? `Last opened ${new Date(l.lastViewedAt).toLocaleDateString()}` : "Not opened yet";
  return `Active, expires in ${days} day${days === 1 ? "" : "s"}. ${opened}.`;
}

/** One line for a comment in a thread: what happened, in plain words. */
export function describeComment(c: Pick<ReviewComment, "kind" | "authorName" | "body">): string {
  switch (c.kind) {
    case "approved":
      return `${c.authorName} approved this post`;
    case "changes_requested":
      return `${c.authorName} asked for changes`;
    case "updated":
      return `${c.authorName} updated the post`;
    default:
      return c.authorName;
  }
}

export const REVIEWER_NAME_KEY = "lazyrelay.reviewerName";
