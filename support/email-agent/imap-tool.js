#!/usr/bin/env node
// Headless IMAP tool for the lazyrelay-email-operations scheduled task.
// Replaces Thunderbird/computer-use, which cannot be granted to unattended
// scheduled runs. See memory/lazyrelay/feedback-email-agent-draft-and-hold.md.
//
// Usage:
//   node imap-tool.js list-unread <mailbox>
//   node imap-tool.js get-message <mailbox> <uid>
//   node imap-tool.js list-drafts <mailbox>
//   node imap-tool.js save-draft <mailbox> --to <addr> --subject <subj> --in-reply-to <msgid> --body-file <path>
//   node imap-tool.js sort-mailbox <mailbox>
//   node imap-tool.js list-purge-candidates <mailbox> <folder> <days>
//   node imap-tool.js purge-folder <mailbox> <folder> <days>
//
// IMPORTANT re: purge-folder — this PERMANENTLY deletes messages. The scheduled
// task must NEVER call this automatically; it only calls list-purge-candidates
// to report counts, and purge-folder is run later by hand only after the user
// has seen that report and explicitly said to go ahead. See SKILL.md.

const fs = require("fs");
const path = require("path");
const { ImapFlow } = require("imapflow");
const { simpleParser } = require("mailparser");
const nodemailer = require("nodemailer");

const CREDS_PATH = path.join(__dirname, "credentials.local.json");

function loadCreds(mailbox) {
  if (!fs.existsSync(CREDS_PATH)) {
    console.error(
      `Missing ${CREDS_PATH}. Copy credentials.example.json to credentials.local.json and fill in the real passwords (the user must do this step themselves).`
    );
    process.exit(1);
  }
  const all = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8"));
  const creds = all[mailbox];
  if (!creds) {
    console.error(`No credentials entry for "${mailbox}" in credentials.local.json`);
    process.exit(1);
  }
  return creds;
}

async function connect(mailbox) {
  const creds = loadCreds(mailbox);
  const client = new ImapFlow({
    host: creds.host,
    port: creds.port,
    secure: true,
    auth: { user: creds.user, pass: creds.pass },
    logger: false,
  });
  await client.connect();
  return client;
}

async function listUnread(mailbox) {
  const client = await connect(mailbox);
  try {
    const lock = await client.getMailboxLock("INBOX");
    try {
      const results = [];
      for await (const msg of client.fetch(
        { seen: false },
        { envelope: true, uid: true, internalDate: true }
      )) {
        results.push({
          uid: msg.uid,
          from: msg.envelope.from?.[0]?.address || "unknown",
          subject: msg.envelope.subject || "(no subject)",
          date: msg.internalDate,
        });
      }
      console.log(JSON.stringify(results, null, 2));
    } finally {
      lock.release();
    }
  } finally {
    await client.logout();
  }
}

async function deleteMessage(mailbox, folderName, uid) {
  const client = await connect(mailbox);
  try {
    const folderPath = (await resolveFolder(client, folderName)) || folderName;
    const lock = await client.getMailboxLock(folderPath);
    try {
      await client.messageDelete([uid], { uid: true });
      console.log(JSON.stringify({ deleted: true, folderPath, uid }));
    } finally {
      lock.release();
    }
  } finally {
    await client.logout();
  }
}

async function markRead(mailbox, uids) {
  const client = await connect(mailbox);
  try {
    const lock = await client.getMailboxLock("INBOX");
    try {
      await client.messageFlagsAdd(uids.join(","), ["\\Seen"], { uid: true });
      console.log(JSON.stringify({ markedRead: uids }));
    } finally {
      lock.release();
    }
  } finally {
    await client.logout();
  }
}

async function getMessage(mailbox, uid, folderName) {
  const client = await connect(mailbox);
  try {
    const folderPath = folderName ? (await resolveFolder(client, folderName)) || folderName : "INBOX";
    const lock = await client.getMailboxLock(folderPath);
    try {
      const msg = await client.fetchOne(uid, { source: true, uid: true }, { uid: true });
      const parsed = await simpleParser(msg.source);
      console.log(
        JSON.stringify(
          {
            uid,
            from: parsed.from?.text,
            to: parsed.to?.text,
            subject: parsed.subject,
            date: parsed.date,
            messageId: parsed.messageId,
            text: parsed.text,
          },
          null,
          2
        )
      );
    } finally {
      lock.release();
    }
  } finally {
    await client.logout();
  }
}

async function listDrafts(mailbox) {
  const client = await connect(mailbox);
  try {
    // Drafts folder name varies; try common ones.
    const candidates = ["Drafts", "INBOX.Drafts", "INBOX/Drafts"];
    let mailboxPath = null;
    const list = await client.list();
    for (const c of candidates) {
      if (list.some((f) => f.path === c)) {
        mailboxPath = c;
        break;
      }
    }
    if (!mailboxPath) {
      console.log(JSON.stringify({ error: "No Drafts folder found", available: list.map((f) => f.path) }));
      return;
    }
    const lock = await client.getMailboxLock(mailboxPath);
    try {
      const results = [];
      // Fetching "1:*" against an empty mailbox makes the server reject the
      // command outright, so short-circuit instead of surfacing a fake error.
      if (!client.mailbox.exists) {
        console.log(JSON.stringify(results, null, 2));
        return;
      }
      for await (const msg of client.fetch("1:*", { envelope: true, uid: true, internalDate: true })) {
        const ageHours = (Date.now() - new Date(msg.internalDate).getTime()) / 3600000;
        results.push({
          uid: msg.uid,
          to: msg.envelope.to?.[0]?.address || "unknown",
          subject: msg.envelope.subject || "(no subject)",
          date: msg.internalDate,
          ageHours: Math.round(ageHours * 10) / 10,
        });
      }
      console.log(JSON.stringify(results, null, 2));
    } finally {
      lock.release();
    }
  } finally {
    await client.logout();
  }
}

const SIGNATURE_DEPARTMENT = {
  "hello@lazyrelay.com": "General Enquiries",
  "support@lazyrelay.com": "Customer Support",
  "accounts@lazyrelay.com": "Accounts & Billing",
};

// A name per mailbox (Werner's call, 2026-08-21) — same pattern as vendor
// support agents signing as a real person (Paddle's Stevan/Rita) rather
// than a faceless "Customer Support" line. Picked once per mailbox, not
// per-message — a consistent identity, not a rotating cast.
const SIGNATURE_NAME = {
  "hello@lazyrelay.com": "Priya",
  "support@lazyrelay.com": "Jordan",
  "accounts@lazyrelay.com": "Sam",
};

function escapeHtml(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// A paragraph consisting of exactly one line in this form renders as a real
// clickable button instead of a plain-text link. Added 2026-08-21 -- the
// review-request email's link was previously just inline URL text, which
// Werner found unconvincing/easy to miss compared to a real button (matches
// the style already used on lazyrelay.com's own transactional emails, e.g.
// the signup-confirmation email's "Confirm email address" button). Label
// and URL are still escaped before insertion -- this isn't a raw-HTML
// escape hatch, just one specific safe pattern.
const BUTTON_LINE_PATTERN = /^\[BUTTON\]\s*(.+?)\s*\|\s*(https?:\/\/\S+)\s*$/;

function renderButton(label, url) {
  return `<table role="presentation" cellpadding="0" cellspacing="0"><tr>
<td style="background-color:#ff5630;border-radius:8px;padding:12px 24px;">
<a href="${escapeHtml(url)}" style="font-size:15px;font-weight:700;color:#ffffff;text-decoration:none;">${escapeHtml(label)}</a>
</td></tr></table>`;
}

function textToHtmlParagraphs(text) {
  return text
    .trim()
    .split(/\n\s*\n/)
    .map((para) => {
      const buttonMatch = BUTTON_LINE_PATTERN.exec(para.trim());
      if (buttonMatch) return renderButton(buttonMatch[1], buttonMatch[2]);
      return `<p style="margin:0 0 1em 0;">${escapeHtml(para).replace(/\n/g, "<br>")}</p>`;
    })
    .join("\n");
}

function buildSignatureHtml(mailbox) {
  const dept = SIGNATURE_DEPARTMENT[mailbox] || "LazyRelay";
  const name = SIGNATURE_NAME[mailbox];
  const nameLine = name
    ? `<div style="color:#ff5630;font-weight:bold;font-size:16px;">${name}</div><div style="color:#14171f;font-size:13px;">LazyRelay &middot; ${dept}</div>`
    : `<div style="color:#ff5630;font-weight:bold;font-size:16px;">LazyRelay</div><div style="color:#14171f;font-size:13px;">${dept}</div>`;
  return `<table style="font-family:Arial,sans-serif;border-collapse:collapse;"><tr><td style="padding-right:12px;"><img src="https://lazyrelay.com/lazyrelay-signature-logo.png" width="70" height="70" style="display:block;border-radius:16px;" alt="LazyRelay"></td><td style="border-left:2px solid #ff5630;padding-left:12px;">${nameLine}<div style="font-size:12px;color:#5b6472;">${mailbox}</div><div style="font-size:12px;color:#5b6472;">www.lazyrelay.com</div><div style="font-style:italic;font-size:12px;color:#5b6472;margin-top:4px;">Automate. Schedule. Publish. Repeat.</div></td></tr></table>`;
}

async function saveDraft(mailbox, opts) {
  const { to, subject, inReplyTo, bodyFile } = opts;
  const body = fs.readFileSync(bodyFile, "utf8");
  const creds = loadCreds(mailbox);
  const client = await connect(mailbox);
  try {
    const list = await client.list();
    const candidates = ["Drafts", "INBOX.Drafts", "INBOX/Drafts"];
    let mailboxPath = candidates.find((c) => list.some((f) => f.path === c));
    if (!mailboxPath) throw new Error("No Drafts folder found on server");

    const htmlBody = `<html><body style="font-family:Arial,sans-serif;font-size:14px;color:#14171f;">
${textToHtmlParagraphs(body)}
<div style="margin-top:1.5em;">${buildSignatureHtml(creds.user)}</div>
</body></html>`;

    const headerLines = [
      `From: ${creds.user}`,
      `To: ${to}`,
      `Subject: ${subject}`,
      inReplyTo ? `In-Reply-To: ${inReplyTo}` : null,
      `Date: ${new Date().toUTCString()}`,
      `MIME-Version: 1.0`,
      `Content-Type: text/html; charset=utf-8`,
    ].filter(Boolean);
    // The blank line separating headers from body is structural, not optional —
    // don't build it via an array entry that a later .filter(Boolean) could strip.
    const raw = headerLines.join("\r\n") + "\r\n\r\n" + htmlBody;

    const result = await client.append(mailboxPath, raw, ["\\Draft"]);
    console.log(JSON.stringify({ saved: true, mailboxPath, uid: result.uid }));
  } finally {
    await client.logout();
  }
}

// Finds an existing folder from a list of naming conventions (servers differ
// on "." vs "/" as the hierarchy separator — same pattern listDrafts already
// uses for the Drafts folder).
function findFolder(list, candidates) {
  return candidates.find((c) => list.some((f) => f.path === c)) || null;
}

// Creates a folder matching the delimiter INBOX itself uses, so a brand-new
// "Promotions" folder nests the same way Drafts/Sent/Junk already do on this
// server instead of guessing "." vs "/".
async function ensureFolder(client, list, name) {
  const existing = findFolder(list, [name, `INBOX.${name}`, `INBOX/${name}`]);
  if (existing) return existing;
  const inbox = list.find((f) => f.path === "INBOX");
  const delimiter = inbox?.delimiter || ".";
  const path = `INBOX${delimiter}${name}`;
  await client.mailboxCreate(path);
  return path;
}

function getHeaderValue(headersBuffer, name) {
  if (!headersBuffer) return null;
  const text = headersBuffer.toString("utf8");
  const re = new RegExp(`^${name}:\\s*(.*)$`, "im");
  const match = text.match(re);
  return match ? match[1].trim() : null;
}

function isSpamHeaders(headersBuffer) {
  const flag = getHeaderValue(headersBuffer, "x-spam-flag");
  const status = getHeaderValue(headersBuffer, "x-spam-status");
  return (flag && /^yes$/i.test(flag)) || (status && /^yes/i.test(status));
}

function isPromoHeaders(headersBuffer) {
  // List-Unsubscribe is the standard marker for bulk/marketing mail (used by
  // every legitimate newsletter/ESP) — a real person-to-person email never
  // has this header, so it's a reliable, low-risk signal to sort on.
  return !!getHeaderValue(headersBuffer, "list-unsubscribe");
}

// Moves obviously-spam and obviously-promotional mail out of INBOX into their
// own folders. This is a MOVE, not a delete — fully reversible, safe to run
// unattended on every scheduled pass. Actual deletion is a separate, manual step
// (see purge-folder below).
async function sortMailbox(mailbox) {
  const client = await connect(mailbox);
  try {
    const list = await client.list();
    const lock = await client.getMailboxLock("INBOX");
    let spamUids = [];
    let promoUids = [];
    try {
      if (client.mailbox.exists) {
        for await (const msg of client.fetch(
          "1:*",
          { uid: true, headers: ["x-spam-flag", "x-spam-status", "list-unsubscribe"] }
        )) {
          if (isSpamHeaders(msg.headers)) {
            spamUids.push(msg.uid);
          } else if (isPromoHeaders(msg.headers)) {
            promoUids.push(msg.uid);
          }
        }
      }

      let spamFolder = null;
      let promoFolder = null;
      if (spamUids.length) {
        spamFolder = findFolder(list, ["Junk", "INBOX.Junk", "INBOX/Junk", "Spam", "INBOX.Spam", "INBOX/Spam"]) || (await ensureFolder(client, list, "Spam"));
        await client.messageMove(spamUids, spamFolder, { uid: true });
      }
      if (promoUids.length) {
        promoFolder = await ensureFolder(client, list, "Promotions");
        await client.messageMove(promoUids, promoFolder, { uid: true });
      }
      console.log(
        JSON.stringify(
          { spamMoved: spamUids.length, spamFolder, promoMoved: promoUids.length, promoFolder },
          null,
          2
        )
      );
    } finally {
      lock.release();
    }
  } finally {
    await client.logout();
  }
}

async function resolveFolder(client, folderName) {
  const list = await client.list();
  const found = findFolder(list, [
    folderName,
    `INBOX.${folderName}`,
    `INBOX/${folderName}`,
  ]);
  return found;
}

// Read-only report of what's eligible for deletion — a folder's messages
// older than N days. Never deletes anything itself. The scheduled cleanup
// task calls this and posts the counts/subjects to Slack for the user to
// review; only a human decision afterward should trigger purge-folder.
async function listPurgeCandidates(mailbox, folderName, days) {
  const client = await connect(mailbox);
  try {
    const folderPath = await resolveFolder(client, folderName);
    if (!folderPath) {
      console.log(JSON.stringify({ error: `No "${folderName}" folder found`, folderName }));
      return;
    }
    const lock = await client.getMailboxLock(folderPath);
    try {
      const results = [];
      if (client.mailbox.exists) {
        const cutoffMs = Date.now() - Number(days) * 86400000;
        for await (const msg of client.fetch("1:*", { envelope: true, uid: true, internalDate: true })) {
          const ts = new Date(msg.internalDate).getTime();
          if (ts <= cutoffMs) {
            results.push({
              uid: msg.uid,
              from: msg.envelope.from?.[0]?.address || "unknown",
              subject: msg.envelope.subject || "(no subject)",
              date: msg.internalDate,
              ageDays: Math.round((Date.now() - ts) / 86400000),
            });
          }
        }
      }
      console.log(JSON.stringify({ folderPath, count: results.length, messages: results }, null, 2));
    } finally {
      lock.release();
    }
  } finally {
    await client.logout();
  }
}

// PERMANENTLY deletes messages in a folder older than N days. Must only be
// invoked by hand after a human has reviewed a list-purge-candidates report
// and explicitly said to proceed — never call this from an unattended
// scheduled task run. See the usage note at the top of this file.
async function purgeFolder(mailbox, folderName, days) {
  const client = await connect(mailbox);
  try {
    const folderPath = await resolveFolder(client, folderName);
    if (!folderPath) {
      console.log(JSON.stringify({ error: `No "${folderName}" folder found`, folderName }));
      return;
    }
    const lock = await client.getMailboxLock(folderPath);
    try {
      const uidsToDelete = [];
      if (client.mailbox.exists) {
        const cutoffMs = Date.now() - Number(days) * 86400000;
        for await (const msg of client.fetch("1:*", { uid: true, internalDate: true })) {
          if (new Date(msg.internalDate).getTime() <= cutoffMs) {
            uidsToDelete.push(msg.uid);
          }
        }
      }
      if (uidsToDelete.length) {
        await client.messageDelete(uidsToDelete, { uid: true });
      }
      console.log(JSON.stringify({ folderPath, deleted: uidsToDelete.length, uids: uidsToDelete }, null, 2));
    } finally {
      lock.release();
    }
  } finally {
    await client.logout();
  }
}

function parseFlags(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      out[argv[i].slice(2)] = argv[i + 1];
      i++;
    }
  }
  return out;
}

async function searchAll(mailbox, term) {
  const client = await connect(mailbox);
  try {
    const list = await client.list();
    const found = [];
    for (const box of list) {
      if (box.flags && box.flags.has("\\Noselect")) continue;
      const lock = await client.getMailboxLock(box.path);
      try {
        const uids = await client.search(
          { or: [{ subject: term }, { body: term }, { from: term }] },
          { uid: true }
        );
        if (uids && uids.length) {
          for await (const msg of client.fetch(
            uids,
            { envelope: true, uid: true, internalDate: true },
            { uid: true }
          )) {
            found.push({
              folder: box.path,
              uid: msg.uid,
              from: msg.envelope.from?.[0]?.address || "unknown",
              subject: msg.envelope.subject || "(no subject)",
              date: msg.internalDate,
            });
          }
        }
      } catch (e) {
        // some folders (e.g. Noselect containers) can't be searched; skip
      } finally {
        lock.release();
      }
    }
    console.log(JSON.stringify(found, null, 2));
  } finally {
    await client.logout();
  }
}

async function sendMail(mailbox, opts) {
  const creds = loadCreds(mailbox);
  const transporter = nodemailer.createTransport({
    host: creds.host,
    port: 465,
    secure: true,
    auth: { user: creds.user, pass: creds.pass },
  });
  const body = fs.readFileSync(opts.bodyFile, "utf8");
  const html = `<html><body style="font-family:Arial,sans-serif;font-size:14px;color:#14171f;">
${textToHtmlParagraphs(body)}
<div style="margin-top:1.5em;">${buildSignatureHtml(creds.user)}</div>
</body></html>`;
  const mailOptions = {
    from: creds.user,
    to: opts.to,
    subject: opts.subject,
    html,
  };
  if (opts.inReplyTo) {
    mailOptions.inReplyTo = opts.inReplyTo;
    mailOptions.references = opts.inReplyTo;
  }
  if (opts.attach) {
    mailOptions.attachments = opts.attach.split(",").map((p) => ({ path: p.trim() }));
  }
  const info = await transporter.sendMail(mailOptions);

  // Keep a local paper trail: nodemailer only submits via SMTP, it never
  // copies the message anywhere IMAP-visible. Without this, a sent reply
  // exists only as a server "250 OK" in a log — unrecoverable later if
  // someone asks "what exactly did we tell them," especially if the other
  // side starts a fresh thread instead of replying on the same one.
  let savedToSent = false;
  let sentError = null;
  try {
    const client = await connect(mailbox);
    try {
      const list = await client.list();
      const sentFolder = findFolder(list, ["Sent", "INBOX.Sent", "INBOX/Sent"]) || (await ensureFolder(client, list, "Sent"));
      const headerLines = [
        `From: ${creds.user}`,
        `To: ${opts.to}`,
        `Subject: ${opts.subject}`,
        `Message-Id: ${info.messageId}`,
        opts.inReplyTo ? `In-Reply-To: ${opts.inReplyTo}` : null,
        opts.inReplyTo ? `References: ${opts.inReplyTo}` : null,
        `Date: ${new Date().toUTCString()}`,
        `MIME-Version: 1.0`,
        `Content-Type: text/html; charset=utf-8`,
      ].filter(Boolean);
      const raw = headerLines.join("\r\n") + "\r\n\r\n" + html;
      await client.append(sentFolder, raw, ["\\Seen"]);
      savedToSent = true;
    } finally {
      await client.logout();
    }
  } catch (e) {
    sentError = e.message || String(e);
  }

  console.log(
    JSON.stringify({ sent: true, messageId: info.messageId, response: info.response, savedToSent, sentError }, null, 2),
  );
}

async function main() {
  const [, , cmd, mailbox, ...rest] = process.argv;
  if (!cmd || !mailbox) {
    console.error(
      "Usage: node imap-tool.js <list-unread|get-message|list-drafts|save-draft|send-mail|sort-mailbox|list-purge-candidates|purge-folder|search-all|mark-read|delete-message> <mailbox> [args]"
    );
    process.exit(1);
  }
  if (cmd === "search-all") return searchAll(mailbox, rest[0]);
  if (cmd === "send-mail") {
    const flags = parseFlags(rest);
    return sendMail(mailbox, {
      to: flags.to,
      subject: flags.subject,
      inReplyTo: flags["in-reply-to"],
      bodyFile: flags["body-file"],
      attach: flags.attach,
    });
  }
  if (cmd === "list-unread") return listUnread(mailbox);
  if (cmd === "get-message") return getMessage(mailbox, rest[0], rest[1]);
  if (cmd === "list-drafts") return listDrafts(mailbox);
  if (cmd === "save-draft") {
    const flags = parseFlags(rest);
    return saveDraft(mailbox, {
      to: flags.to,
      subject: flags.subject,
      inReplyTo: flags["in-reply-to"],
      bodyFile: flags["body-file"],
    });
  }
  if (cmd === "sort-mailbox") return sortMailbox(mailbox);
  if (cmd === "mark-read") return markRead(mailbox, rest);
  if (cmd === "delete-message") return deleteMessage(mailbox, rest[0], rest[1]);
  if (cmd === "list-purge-candidates") return listPurgeCandidates(mailbox, rest[0], rest[1]);
  if (cmd === "purge-folder") return purgeFolder(mailbox, rest[0], rest[1]);
  console.error(`Unknown command: ${cmd}`);
  process.exit(1);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
