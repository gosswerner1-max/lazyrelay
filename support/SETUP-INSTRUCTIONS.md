# Data Collector Setup & Dashboard Integration

## Step 1: Email Credentials Setup

The data collector needs IMAP credentials for the four LazyRelay mailboxes.

1. Copy `credentials.example.json` to `credentials.local.json`:
   ```bash
   cp credentials.example.json credentials.local.json
   ```

2. Fill in the password for each mailbox (same password for all, per Werner):
   ```json
   {
     "hello@lazyrelay.com": {
       "host": "mail.lazyrelay.com",
       "port": 993,
       "user": "hello@lazyrelay.com",
       "pass": "YOUR_PASSWORD_HERE"
     },
     ...
   }
   ```

3. Save and test with:
   ```bash
   node data-collector.js
   ```

   If successful, you'll see:
   ```
   Starting data collection...
   Fetching emails...
     hello@lazyrelay.com: 5 unread
     support@lazyrelay.com: 2 unread
     accounts@lazyrelay.com: 0 unread
     werner@lazyrelay.com: 3 unread
   Parsing Active Priorities...
     Found 12 open tasks
   
   Data collection complete.
   Output: C:\Users\werne\Documents\werner-brain\morning-brief-data.json
   Items: 22 total
     Critical: 2
     Warning: 3
     Review: 10
     Info: 7
   ```

## Step 2: Run the Collector

### On-Demand (Manual)
```bash
cd C:\Users\werne\Claude\LazyRelay\support
node data-collector.js
```

The JSON file will be created/updated at:
```
C:\Users\werne\Documents\werner-brain\morning-brief-data.json
```

### Scheduled (Daily at 8:00 AM)

Use Claude Code's scheduled task feature or a Windows task. The simplest approach is to add a scheduler entry in `.claude/scheduled-tasks/`.

Example cron-scheduled run:
```
0 8 * * * node C:\Users\werne\Claude\LazyRelay\support\data-collector.js
```

## Step 3: Connect Dashboard to Data

Your Morning Brief artifact (https://claude.ai/artifact/96f8sofWzfCP6aZqHUdC1x) needs to read this JSON file.

### Option A: Dashboard Reads Local File (Recommended)
If your dashboard has file access, load the JSON directly:
```javascript
fetch('file:///C:/Users/werne/Documents/werner-brain/morning-brief-data.json')
  .then(r => r.json())
  .then(data => renderDashboard(data))
```

### Option B: Dashboard Reads from Cloud Storage
Upload the JSON to a cloud service (Google Drive, Dropbox, etc.) and have the dashboard fetch from there:
```javascript
fetch('https://your-cloud-storage.example.com/morning-brief-data.json')
  .then(r => r.json())
  .then(data => renderDashboard(data))
```

### Option C: Use Claude Docs Database (Advanced)
If your artifact has access to Claude's database capability, the collector can write directly:
```javascript
// In the dashboard artifact
const db = await claude.database.read('morning-brief-data');
renderDashboard(db);
```

## Step 4: Display in Dashboard

The dashboard should show items grouped by priority:

1. **Critical** (top) — Red badge
   - Show all critical items
   - Sort by date (newest first)
   - Add "Action needed" indicator

2. **Warning** (second) — Orange badge
   - Show all warning items
   - Sort by date

3. **Review** (third) — Yellow badge
   - Show top 5-10 items
   - Sort by date

4. **Info** (optional) — Blue badge
   - Show top 5 items
   - Sort by date

For each item, display:
- **Priority badge** (color)
- **Title** (truncated if needed)
- **Description** (first 100-150 chars)
- **Source** (email from X mailbox, or Active Priorities task)
- **Date** (relative: "2 hours ago", "today")
- **Action button** (for emails, open in Thunderbird)

## Data Structure Reference

See `morning-brief-data.example.json` for a complete example.

Each item has:
```json
{
  "id": "unique-id",
  "priority": "critical|warning|review|info",
  "source": "email|active-priorities",
  "title": "Email subject or task title",
  "description": "Preview text",
  "mailbox": "hello@lazyrelay.com (email only)",
  "from": "sender@example.com (email only)",
  "date": "ISO timestamp",
  "actions": [
    {
      "label": "Open in Thunderbird",
      "type": "link",
      "value": "thunderbird://..."
    }
  ]
}
```

## Filtering & Customization

### Only Show Items That Need Action

The collector already filters for:
- Unread emails (ignores archived/read mail)
- Open tasks only (ignores completed items)

No background/info-only items slip through.

### Adjust Priority Thresholds

Edit `data-collector.js` in the `categorizeEmail()` and `parseActivePriorities()` functions to tweak what counts as critical/warning/review/info.

### Add More Data Sources

The collector is designed to be extensible. Add new data sources by:
1. Create a new `fetch*()` function
2. Convert data to dashboard item format
3. Push items to the `allItems` array
4. Add logging for the data source

Example: Add Slack notifications:
```javascript
async function fetchSlackAlerts() {
  // Connect to Slack API
  // Filter for messages in a specific channel
  // Convert to dashboard items
  // Return items array
}
```

## Troubleshooting

### "Missing credentials.local.json"
Copy `credentials.example.json` to `credentials.local.json` and fill in the password.

### "Cannot connect to IMAP"
1. Verify IMAP is enabled in cPanel
2. Check that the host is correct (`mail.lazyrelay.com`)
3. Test with a mail client first (Thunderbird) to confirm credentials work

### "No unread emails found"
This is normal if you've already read all emails. The dashboard will only show unread messages. Check Thunderbird to see all mail.

### "Active Priorities.md not found"
The vault path is hardcoded to `C:\Users\werne\Documents\werner-brain`. If you moved the vault, update the `VAULT_PATH` in `data-collector.js`.

### JSON file is empty or truncated
Check that the output directory exists and is writable. The default is the vault root.

## Next Steps

1. **Test the collector** — Run it once manually to verify email/vault reading
2. **Check the JSON output** — Open the JSON file in a text editor to see what was collected
3. **Update your dashboard** — Add code to read and display the JSON
4. **Set up scheduling** — Use a cron job or Windows task to run daily at 8:00 AM
5. **Refine priorities** — Adjust email categorization rules as you see what gets flagged

## Performance Notes

- **First run** may take 10-15 seconds (IMAP connections + vault read)
- **Subsequent runs** typically take 5-10 seconds
- If you have many unread emails (100+), it may take longer

If performance is an issue, consider:
- Archiving old emails in Thunderbird
- Running the collector less frequently
- Adding a limit to max items returned per mailbox

---

**Files:**
- `data-collector.js` — Main script
- `credentials.local.json` — IMAP credentials (create from example)
- `morning-brief-data.json` — Generated output (vault root)
- `DATA-COLLECTOR-README.md` — Full documentation
- `morning-brief-data.example.json` — Example output format
