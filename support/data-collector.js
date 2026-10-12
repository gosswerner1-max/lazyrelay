#!/usr/bin/env node
/**
 * Morning Brief Data Collector + Server
 * Aggregates actionable items from emails and Active Priorities into a JSON file
 * for the Morning Brief dashboard. Also runs an HTTP server on port 3001 to serve the JSON.
 *
 * Usage:
 *   node data-collector.js
 *
 * Output:
 *   C:\Users\werne\Documents\werner-brain\morning-brief-data.json
 *   HTTP server: http://localhost:3001/morning-brief-data.json
 *
 * Data sources:
 *   1. LazyRelay email inboxes (hello@, support@, accounts@, werner@lazyrelay.com)
 *   2. Active Priorities.md from the vault
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');

const CREDS_PATH = path.join(__dirname, 'credentials.local.json');
const VAULT_PATH = 'C:\\Users\\werne\\Documents\\werner-brain';
const ACTIVE_PRIORITIES_FILE = path.join(VAULT_PATH, 'Active Priorities.md');
const OUTPUT_FILE = path.join(VAULT_PATH, 'morning-brief-data.json');

// Email mailboxes to check
const MAILBOXES = ['hello@lazyrelay.com', 'support@lazyrelay.com', 'accounts@lazyrelay.com', 'werner@lazyrelay.com'];

/**
 * Load email credentials from the local credentials file
 */
function loadEmailCreds(mailbox) {
  if (!fs.existsSync(CREDS_PATH)) {
    console.error(`Missing ${CREDS_PATH}. Cannot read email credentials.`);
    return null;
  }
  const all = JSON.parse(fs.readFileSync(CREDS_PATH, 'utf8'));
  return all[mailbox] || null;
}

/**
 * Connect to IMAP and fetch unread emails
 */
async function fetchUnreadEmails(mailbox) {
  const creds = loadEmailCreds(mailbox);
  if (!creds) {
    console.warn(`Skipping ${mailbox} - no credentials found`);
    return [];
  }

  try {
    const client = new ImapFlow({
      host: creds.host,
      port: creds.port,
      secure: true,
      auth: { user: creds.user, pass: creds.pass },
      logger: false,
    });

    await client.connect();
    const emails = [];

    try {
      const lock = await client.getMailboxLock('INBOX');
      try {
        for await (const msg of client.fetch(
          { seen: false },
          { envelope: true, uid: true, internalDate: true, raw: '' }
        )) {
          let text = '';
          let subject = msg.envelope.subject || '(no subject)';

          // Parse the email body to extract text
          try {
            const parsed = await simpleParser(msg.raw);
            text = parsed.text || parsed.textAsHtml || '';
          } catch (e) {
            text = '(unable to parse email body)';
          }

          emails.push({
            uid: msg.uid,
            from: msg.envelope.from?.[0]?.address || 'unknown',
            fromName: msg.envelope.from?.[0]?.name || '',
            subject: subject,
            date: msg.internalDate,
            mailbox: mailbox,
            preview: text.substring(0, 200).trim(),
            fullText: text,
          });
        }
      } finally {
        lock.release();
      }
    } finally {
      await client.logout();
    }

    return emails;
  } catch (error) {
    console.warn(`Error fetching emails from ${mailbox}:`, error.message);
    return [];
  }
}

/**
 * Categorize an email based on sender and subject
 */
function categorizeEmail(email) {
  const subject = email.subject.toLowerCase();
  const from = email.from.toLowerCase();

  // Critical: errors, failures, security issues
  if (
    subject.includes('error') ||
    subject.includes('failed') ||
    subject.includes('critical') ||
    subject.includes('urgent') ||
    subject.includes('alert') ||
    subject.includes('breach') ||
    subject.includes('security')
  ) {
    return 'critical';
  }

  // Warning: action needed, requires attention
  if (
    subject.includes('action required') ||
    subject.includes('requires attention') ||
    subject.includes('verify') ||
    subject.includes('confirm') ||
    subject.includes('appeal') ||
    subject.includes('review')
  ) {
    return 'warning';
  }

  // Review: customer inquiries, feedback
  if (
    subject.includes('customer') ||
    subject.includes('support') ||
    subject.includes('feedback') ||
    subject.includes('question') ||
    subject.includes('issue') ||
    subject.includes('help')
  ) {
    return 'review';
  }

  // Info: updates, notifications
  if (
    subject.includes('invoice') ||
    subject.includes('receipt') ||
    subject.includes('notification') ||
    subject.includes('update') ||
    subject.includes('report') ||
    subject.includes('summary')
  ) {
    return 'info';
  }

  return 'info';
}

/**
 * Convert email to dashboard item format
 */
function emailToDashboardItem(email) {
  const category = categorizeEmail(email);
  const id = `email-${email.uid}-${email.mailbox}`;

  return {
    id,
    priority: category,
    source: 'email',
    from: email.from,
    fromName: email.fromName,
    title: email.subject,
    description: email.preview,
    mailbox: email.mailbox,
    date: email.date,
    actions: [
      {
        label: 'Open in Thunderbird',
        type: 'link',
        value: `thunderbird:///search?folder=${email.mailbox}&uid=${email.uid}`,
      },
    ],
  };
}

/**
 * Parse Active Priorities.md and extract open tasks
 */
function parseActivePriorities() {
  // Rewritten 2026-10-02 for the new queue layout of Active Priorities.md:
  // a "## Waiting on Werner" block at the top (plain "- " bullets under
  // "**Decisions you owe**" and "**Steps only you can do**"), then one
  // "## <Business>" section per business with one "- [ ]" line per item.
  // The old "### Open Tasks" gate no longer exists; without this change the
  // collector returned 0 tasks.
  if (!fs.existsSync(ACTIVE_PRIORITIES_FILE)) {
    console.warn(`Active Priorities file not found at ${ACTIVE_PRIORITIES_FILE}`);
    return [];
  }

  const content = fs.readFileSync(ACTIVE_PRIORITIES_FILE, 'utf8');
  const items = [];
  let id = 0;
  let section = '';
  let waitingSub = '';

  const clean = (s) => s.replace(/\*\*/g, '').replace(/\[\[([^\]|]+)(\|[^\]]+)?\]\]/g, '$1').trim();

  for (const rawLine of content.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (line.startsWith('## ')) { section = line.slice(3).trim(); waitingSub = ''; continue; }
    const inWaiting = section.toLowerCase().startsWith('waiting on werner');
    if (inWaiting && /^\*\*.+\*\*$/.test(line.trim())) { waitingSub = clean(line); continue; }

    // Waiting-on-Werner bullets: the user's own decisions and steps, always top priority.
    if (inWaiting && line.trim().startsWith('- ')) {
      id++;
      const text = clean(line.trim().slice(2));
      items.push({
        id: `waiting-${id}`,
        priority: 'critical',
        source: 'active-priorities',
        section: `Waiting on Werner: ${waitingSub || 'item'}`,
        title: text.length > 110 ? text.slice(0, 107) + '...' : text,
        description: text,
        date: new Date().toISOString(),
        rawText: line.trim(),
      });
      continue;
    }

    // Queue items under a business section.
    if (line.trim().startsWith('- [ ]')) {
      id++;
      const taskText = line.trim().replace(/^- \[ \]\s*/, '');
      const text = clean(taskText);
      const parked = /\bPARKED\b/i.test(taskText) || /\bDeferred until paying customers\b/i.test(taskText);
      const watch = /\b(watch items?|standing watch|Don't "fix")/i.test(taskText);
      const needsWerner = /needs? werner|werner's (call|go-ahead)|awaiting (werner|review)/i.test(taskText);
      let priority = 'review';
      if (parked) priority = 'info';
      else if (watch) priority = 'info';
      else if (needsWerner) priority = 'warning';
      const titleMatch = taskText.match(/\*\*([^*]+)\*\*/);
      const title = titleMatch ? clean(titleMatch[1]) : (text.length > 110 ? text.slice(0, 107) + '...' : text);
      items.push({
        id: `priority-${id}`,
        priority,
        source: 'active-priorities',
        section: section || 'Queue',
        title,
        description: text.slice(0, 300),
        date: new Date().toISOString(),
        rawText: taskText,
      });
    }
  }

  return items;
}

/**
 * Main function to collect all data and output JSON
 */
async function collectData() {
  console.log('Starting data collection...');

  const allItems = [];

  // 1. Fetch emails from all mailboxes
  console.log('Fetching emails...');
  for (const mailbox of MAILBOXES) {
    try {
      const emails = await fetchUnreadEmails(mailbox);
      const emailItems = emails.map(emailToDashboardItem);
      allItems.push(...emailItems);
      console.log(`  ${mailbox}: ${emails.length} unread`);
    } catch (error) {
      console.warn(`  Error with ${mailbox}:`, error.message);
    }
  }

  // 2. Parse Active Priorities
  console.log('Parsing Active Priorities...');
  const priorityItems = parseActivePriorities();
  allItems.push(...priorityItems);
  console.log(`  Found ${priorityItems.length} open tasks`);

  // 3. Sort by priority (critical > warning > review > info)
  const priorityOrder = { critical: 0, warning: 1, review: 2, info: 3 };
  allItems.sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority]);

  // 4. Output JSON
  const output = {
    timestamp: new Date().toISOString(),
    totalItems: allItems.length,
    byPriority: {
      critical: allItems.filter(i => i.priority === 'critical').length,
      warning: allItems.filter(i => i.priority === 'warning').length,
      review: allItems.filter(i => i.priority === 'review').length,
      info: allItems.filter(i => i.priority === 'info').length,
    },
    items: allItems,
  };

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2));
  console.log(`\nData collection complete.`);
  console.log(`Output: ${OUTPUT_FILE}`);
  console.log(`Items: ${allItems.length} total`);
  console.log(`  Critical: ${output.byPriority.critical}`);
  console.log(`  Warning: ${output.byPriority.warning}`);
  console.log(`  Review: ${output.byPriority.review}`);
  console.log(`  Info: ${output.byPriority.info}`);
}

// --once (added 2026-10-02): collect, write the JSON, exit. No HTTP server.
// This is what the 08:55 Windows job "Morning Brief Data Collector" and
// refresh-brief.ps1 use, so a scheduled run never fights the dashboard's
// own server (server.js) for port 3001. Plain `node data-collector.js`
// keeps the old behaviour (collect once, then serve on 3001 until stopped).
if (process.argv.includes('--once')) {
  collectData()
    .then(() => process.exit(0))
    .catch((error) => { console.error('Collection error:', error); process.exit(1); });
  return;
}

// Start HTTP server to serve the JSON data
const PORT = 3001;
const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');

  if (req.url === '/morning-brief-data.json') {
    fs.readFile(OUTPUT_FILE, (err, data) => {
      if (err) {
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'Data not ready yet. Try running collection first.' }));
      } else {
        res.writeHead(200);
        res.end(data);
      }
    });
  } else if (req.url === '/health') {
    res.writeHead(200);
    res.end(JSON.stringify({ status: 'ok', timestamp: new Date().toISOString() }));
  } else {
    res.writeHead(404);
    res.end(JSON.stringify({ error: 'Not found' }));
  }
});

server.listen(PORT, () => {
  console.log(`\nHTTP Server running on http://localhost:${PORT}`);
  console.log(`Morning Brief data endpoint: http://localhost:${PORT}/morning-brief-data.json`);
  console.log(`Health check: http://localhost:${PORT}/health`);
  console.log('\nServer is running. Press Ctrl+C to stop.');
});

// Run the collector once on startup, then periodically
async function runCollector() {
  try {
    await collectData();
  } catch (error) {
    console.error('Collection error:', error);
  }
}

// Collect data immediately
runCollector();

// Refresh data every 5 minutes (optional; remove if you only want manual runs)
// setInterval(runCollector, 5 * 60 * 1000);
