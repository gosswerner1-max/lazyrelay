# Morning Brief Data Collector

Aggregates actionable items from email inboxes and Active Priorities.md into a JSON file for the Morning Brief dashboard.

## Quick Start

```bash
node data-collector.js
```

The script will:
1. Connect to all four LazyRelay email inboxes
2. Extract unread emails that need action
3. Parse Active Priorities.md from the vault
4. Categorize all items by priority
5. Output a JSON file to `C:\Users\werne\Documents\werner-brain\morning-brief-data.json`

## Setup Requirements

### Email Credentials
The script reads from `credentials.local.json` in this directory. This file must exist and contain IMAP credentials for the four mailboxes:

```json
{
  "hello@lazyrelay.com": {
    "host": "mail.lazyrelay.com",
    "port": 993,
    "user": "hello@lazyrelay.com",
    "pass": "password"
  },
  "support@lazyrelay.com": { ... },
  "accounts@lazyrelay.com": { ... },
  "werner@lazyrelay.com": { ... }
}
```

**Note:** This file is `.gitignore`d. See `credentials.example.json` for the template.

## Data Sources

### 1. Email Inboxes
Scans unread emails in:
- `hello@lazyrelay.com`
- `support@lazyrelay.com`
- `accounts@lazyrelay.com`
- `werner@lazyrelay.com`

Each email is categorized as:
- **critical** — errors, failures, security issues, urgent alerts
- **warning** — action required, verification needed, appeals
- **review** — customer questions, support requests
- **info** — invoices, receipts, notifications, updates

### 2. Active Priorities.md
Extracts all open tasks (`- [ ]` items) from the vault's master task list.

Priorities are assigned based on tags in the task text:
- **critical** — `[lazyrelay]`, `CRITICAL`, `NEW`
- **warning** — `[lazy-download]`, `UPDATED`
- **review** — customer/product related
- **info** — `[meta]`, `DECIDED`

## Output Format

`morning-brief-data.json` has this structure:

```json
{
  "timestamp": "2026-10-02T08:30:00.000Z",
  "totalItems": 15,
  "byPriority": {
    "critical": 2,
    "warning": 4,
    "review": 5,
    "info": 4
  },
  "items": [
    {
      "id": "email-123-hello@lazyrelay.com",
      "priority": "critical",
      "source": "email",
      "from": "support@example.com",
      "fromName": "Support Team",
      "title": "Urgent: Database connection error",
      "description": "The production database is experiencing intermittent...",
      "mailbox": "hello@lazyrelay.com",
      "date": "2026-10-02T07:45:00.000Z",
      "actions": [
        {
          "label": "Open in Thunderbird",
          "type": "link",
          "value": "thunderbird:///search?folder=hello@lazyrelay.com&uid=123"
        }
      ]
    },
    {
      "id": "priority-1",
      "priority": "warning",
      "source": "active-priorities",
      "title": "Etsy: shop is now only the new products (39 active...",
      "description": "Werner creates the 80% sale himself; next is LazyRelay journey ebook...",
      "date": "2026-10-02T08:30:00.000Z",
      "rawText": "**NEW 2026-10-01 by James - [lazy-download] Etsy: shop..."
    }
  ]
}
```

### Item Fields

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Unique identifier (email UID or task number) |
| `priority` | string | critical \| warning \| review \| info |
| `source` | string | email \| active-priorities |
| `from` | string | Email sender (email only) |
| `title` | string | Email subject or task title |
| `description` | string | Email preview or task description |
| `mailbox` | string | Source mailbox (email only) |
| `date` | ISO string | Email date or current time |
| `actions` | array | Action buttons (email only) |
| `rawText` | string | Full task text from Active Priorities (tasks only) |

## Filtering Items

The dashboard should display:
- All **critical** items
- All **warning** items
- Top 5-10 **review** items (most recent first)
- Top 5 **info** items (optional, lowest priority)

Only show items that actually need Werner's input/decision/action. Background items are filtered out at the email-categorization level.

## Running on Schedule

To run this daily at 8:00 AM, add a scheduled task in `.claude/scheduled-tasks/` or use the `schedule` skill:

```bash
node C:\Users\werne\Claude\LazyRelay\support\data-collector.js
```

The JSON output will be ready for the dashboard to load at `https://claude.ai/artifact/96f8sofWzfCP6aZqHUdC1x`.

## Troubleshooting

### Email credentials not found
```
Missing C:\Users\werne\Claude\LazyRelay\support\credentials.local.json
```
Copy `credentials.example.json` to `credentials.local.json` and fill in the IMAP credentials for each mailbox.

### IMAP connection failed
Check that:
1. IMAP is enabled in cPanel/mail server settings
2. Credentials are correct
3. The mailbox accepts IMAP connections (some shared hosting blocks this by default)

### Active Priorities.md not found
The vault path is hardcoded to `C:\Users\werne\Documents\werner-brain`. If the vault is in a different location, update `VAULT_PATH` in the script.

### No unread emails
This is normal — only unread emails appear in the dashboard. Existing task lists can be opened in Thunderbird or the vault directly.

## Dependencies

The script uses the same libraries as `imap-tool.js`:
- `imapflow` — IMAP client
- `mailparser` — Email parsing
- Node.js built-ins (`fs`, `path`)

Install with:
```bash
npm install imapflow mailparser
```

Both should already be installed since `imap-tool.js` uses them.
