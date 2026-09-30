// Help text for the CLI. Plain ASCII: no special dashes.

export const TOP_HELP = `lazyrelay - the LazyRelay command line

Usage:
  lazyrelay <command> [options]

Commands:
  whoami                         Check the API key and show how many accounts are connected
  accounts                       List connected social accounts
  rules [platform]               Show what a platform accepts (text limit, media, required fields)
  posts list                     List posts
  posts schedule                 Schedule a post to one account
  posts now                      Publish a post right away
  posts delete <id>              Cancel or delete a post
  posts approve <id>             Approve a post that is waiting for approval
  posts reschedule <id>          Move a pending post to a new time
  posts pause <id>               Hold a pending post
  posts resume <id>              Release a paused post
  posts history                  Older posted and failed posts
  proof <id>                     Get the public proof-of-publish link for a post
  media upload <file>            Upload an image, video or PDF and print its URL
  slots next <accountId>         Next free posting time for an account
  tiktok <accountId>             What a TikTok account allows (privacy levels, can post, longest video)
  boards <accountId>             A Pinterest account's boards
  review create                  Create a client review link and print its URL
  review list                    List client review links
  review revoke <id>             Stop a client review link
  analytics                      Post counts and engagement for a recent window
  help                           Show this help

Global options:
  --key <key>        API key (or set LAZYRELAY_API_KEY, which is safer: a --key value shows in process lists)
  --json             Print the raw JSON response instead of a table or line
  --base-url <url>   Use another API address (or set LAZYRELAY_BASE_URL)
  --help, -h         Help for a command, for example: lazyrelay posts schedule --help

Create an API key in the LazyRelay dashboard on the API Keys tab.
Docs: https://lazyrelay.com/docs
`;

const COMPOSE_OPTIONS = `  --account <id>       Connected account id (see: lazyrelay accounts)   required
  --text "<text>"      The post text or caption                          required
  --media <url|file>   Image or video: a public URL, or a local file that is uploaded first.
                       Repeat for several images: --media a.png --media b.png
  --tag a,b            Up to 5 labels for filtering analytics
  --privacy <LEVEL>    TikTok only, required there: PUBLIC_TO_EVERYONE, MUTUAL_FOLLOW_FRIENDS or SELF_ONLY
  --board <id>         Pinterest only: the board to pin to
  --link <url>         Pinterest only: where a click on the pin goes
  --options '<json>'   Platform options, for example '{"instagram":{"placement":"reel"}}'
  --approval           Hold the post until someone approves it
  --json               Print the raw JSON response`;

export const COMMAND_HELP: Record<string, string> = {
  whoami: `Usage: lazyrelay whoami [--json]

Calls the API with your key and prints how many accounts are connected and on which platforms.
`,
  accounts: `Usage: lazyrelay accounts [--json]

Lists every connected social account with the id the posting commands need.
`,
  rules: `Usage: lazyrelay rules [platform] [--json]

With no platform, one line per platform. With a platform such as instagram or tiktok, the full rules:
text limit, media rules, required fields, features and options.
`,
  "posts list": `Usage: lazyrelay posts list [--status <status>] [--account <id>] [--limit <n>] [--json]

Upcoming posts plus the 50 most recent posted or failed ones.

  --status <status>   draft, needs_approval, pending, posting, posted or failed
  --account <id>      Only posts for this account
  --limit <n>         At most n posts
`,
  "posts schedule": `Usage: lazyrelay posts schedule --account <id> --text "<text>" --at <ISO time> [options]

Schedules one post to one account. Run it once per account to post to several.

  --at <time>          When to post, ISO 8601, for example 2026-10-01T09:00:00Z
${COMPOSE_OPTIONS}
`,
  "posts now": `Usage: lazyrelay posts now --account <id> --text "<text>" [options]

Publishes to one account right away. The scheduler picks it up within moments, so the post is
queued, not yet live. Check with: lazyrelay posts list --status posted

${COMPOSE_OPTIONS}
`,
  "posts delete": `Usage: lazyrelay posts delete <id> [--json]

Cancels a pending post, or clears a posted, failed or draft one. A post being published right now cannot be deleted.
`,
  "posts reschedule": `Usage: lazyrelay posts reschedule <id> --at <ISO time> [--json]

Moves a pending post to a new time, for example --at 2026-10-01T09:00:00Z.
`,
  "posts pause": `Usage: lazyrelay posts pause <id> [--json]

Holds a pending post without cancelling it.
`,
  "posts resume": `Usage: lazyrelay posts resume <id> [--json]

Releases a paused post.
`,
  "posts history": `Usage: lazyrelay posts history [--limit <n>] [--before <ISO time>] [--json]

Older posted and failed posts, newest first. Use --before with the oldest time you have seen to page back.

  --limit <n>        1 to 100, default 50
`,
  tiktok: `Usage: lazyrelay tiktok <accountId> [--json]

Shows what one TikTok account allows: privacy levels, whether it can post now, and the longest video.
Run this before posting to TikTok, then pass one of the levels as --privacy.
`,
  boards: `Usage: lazyrelay boards <accountId> [--json]

Lists a Pinterest account's boards. Pass a board id as --board when posting to Pinterest.
`,
  "review create": `Usage: lazyrelay review create [--label <text>] [--days <n>] [--brand <name>] [--json]

Creates a link a client opens (no account needed) to approve posts, and prints the URL to send them.

  --label <text>   Who it is for, for example Acme
  --days <n>       Days until it stops working, 1 to 90 (default 30)
  --brand <name>   Only show posts for this brand
`,
  "review list": `Usage: lazyrelay review list [--json]

Lists client review links with their status and address.
`,
  "review revoke": `Usage: lazyrelay review revoke <id> [--json]

Stops a client review link working at once.
`,
  "posts approve": `Usage: lazyrelay posts approve <id> [--json]

Approves a post that is waiting for approval, so it is scheduled.
`,
  proof: `Usage: lazyrelay proof <id> [--json]

Prints the public proof-of-publish link for a post that was confirmed live.
The API key must be allowed to share proof (a per-key setting in the dashboard).
`,
  "media upload": `Usage: lazyrelay media upload <file> [--alt "<description>"] [--json]

Uploads an image (jpeg, png, webp, gif), a video (mp4, mov, webm) or a PDF, and prints the public URL
to use as --media.
`,
  "slots next": `Usage: lazyrelay slots next <accountId> [--json]

Prints the next free posting time for an account, from the posting times saved in Settings.
`,
  analytics: `Usage: lazyrelay analytics [--days <n>] [--tag <tag>] [--brand <name>] [--json]

  --days <n>     How many days back, 1 to 90 (default 30)
  --tag <tag>    Only posts with this tag
  --brand <name> Only this brand
`,
};

/** The help for a command path such as "posts schedule", or the top-level help. */
export function helpFor(path: string): string {
  return COMMAND_HELP[path] ?? TOP_HELP;
}
