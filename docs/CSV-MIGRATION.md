# CSV migration helper (Buffer and Hootsuite)

`POST /api/migrate/csv` turns a CSV exported from Buffer or Hootsuite into LazyRelay **drafts**, without editing the spreadsheet.
Two steps on one route. Drafts only: nothing is ever scheduled, approved or published by this feature.

Status: backend only, dark by default. The route answers `404 {"error":"Not found"}` unless `CSV_MIGRATION_ENABLED=true`.
The visual column picker is a later task; this document is the contract it will use.

## Read this first: the column layouts are assumptions

The Buffer and Hootsuite layouts below are taken from public documentation. They have **not** been checked against real
exports. The mapper is deliberately tolerant (aliases, case, spacing), and the detected tool name is only a label shown to the
person, never relied on for safety. If a real export differs, the preview returns `needsMapping: true` and the person picks the
columns. Treat the stated layouts as unverified until someone has run a real export through the preview.

| Tool (label only) | Stated headers | Stated time format |
| --- | --- | --- |
| Buffer | `Text`, `Link`, `Posting Time` | `YYYY-MM-DD HH:mm` |
| Hootsuite | `Date`, `Text`, `URL` | `DD/MM/YYYY HH:mm` or `MM/DD/YYYY HH:mm` |

Header aliases (case-insensitive, trimmed, BOM ignored):

| Field | Accepted headers, in priority order |
| --- | --- |
| text (required) | text, message, content, post, caption, copy, body, status, update |
| link | link, url, link url, attachment, shared link |
| planned time | posting time, date, scheduled time, scheduled for, publish time, publish date, time, datetime, schedule, send at |
| ignored with a notice, never read or fetched | media, image, photo, video, profile, account, network, channel, platform, labels, tags |

## Who can call it

A signed-in person only. An API key is refused with 403 (same rule as the other human-only routes). The drafts belong to the
caller's account, taken from the session and never from the request, exactly as `POST /scheduled-posts/draft` decides.

## Request

Either multipart form data (file in the field `file`) or JSON (`{"csv": "<the file text>"}`). Body cap 2 MB.

| Field | Step | Meaning |
| --- | --- | --- |
| `step` | both | `preview` (default) or `confirm` |
| `timezone` | both | IANA name, for example `Africa/Johannesburg`. Default `UTC`. Used to read the times in the file |
| `mapping` | both, optional | `{ "text": "<header>", "link": "<header>", "time": "<header>" }`. In multipart, send it as a JSON string. Each named header must exist in the file (else 400 `invalid_mapping`). A field left out falls back to detection |
| `dateOrder` | confirm (also accepted on preview) | `dmy` or `mdy`. Only used when the preview said `ambiguous`; an unambiguous file keeps its detected order |
| `fileFingerprint` | confirm | The `fileFingerprint` the preview returned. Must match the file sent now (else 409 `file_changed`) |

## Step 1: preview (creates nothing)

`200` with:

```json
{
  "detected": "buffer | hootsuite | unknown",
  "columns": { "text": "Text", "link": "Link", "time": "Posting Time" },
  "needsMapping": false,
  "ignoredColumns": ["Image"],
  "rowsTotal": 12,
  "rowsUsable": 10,
  "noUsableDate": 3,
  "rows": [
    { "row": 2, "text": "excerpt of up to 140 characters", "link": "https://example.com", "plannedDate": "2030-05-17", "plannedTime": "2030-05-17T14:30:00.000Z", "issues": [] }
  ],
  "skipped": [ { "row": 5, "reason": "empty_text | duplicate | too_long" } ],
  "dateOrder": "dmy | mdy | ambiguous | not_applicable",
  "timezone": "UTC",
  "warnings": [],
  "fileFingerprint": "<sha256 of the normalised content>"
}
```

When no text column could be found, `needsMapping` is `true`, `rowsUsable` is 0, and the answer also carries `headers` (all
header names) and `sampleRows` (the first 3 data rows, each cell cut at 200 characters) so the page can let the person choose.

Notes:

* `rows` is the first 20 usable rows; `text` is cut to an excerpt for display only. The real text is never truncated.
* `row` is the position in the file counting the header as row 1 and not counting blank lines.
* `noUsableDate` counts usable rows that end up with no planned date (no time in the cell, unreadable, or in the past).
* `fileFingerprint` is the SHA-256 of the file content after decoding, cleaning and normalising headers, so the same data saved
  with a different delimiter, line ending or BOM gives the same value.
* A row longer than the shortest platform text limit is only a warning in `issues` (it is never cut). A row too long for a
  draft (5,000 characters, including an appended link) is listed in `skipped` as `too_long`.

## Step 2: confirm (creates the drafts)

Send the same file with `step: "confirm"`, the `fileFingerprint` from the preview, and `dateOrder` / `mapping` if the preview
needed them. All drafts are written in one insert. `201` when at least one draft was created, `200` when none were:

```json
{
  "created": 10,
  "skipped": [ { "row": 5, "reason": "empty_text | duplicate | too_long | already_imported" } ],
  "draftIds": ["<uuid>"],
  "remaining": 0
}
```

What each draft holds: the text; the link appended after a blank line only when the text does not already contain it (and only
for `http` / `https` links up to 2,048 characters); `status: "draft"`; no connected account; `scheduled_for: null`; the planned
date as the plain `YYYY-MM-DD` the existing draft field takes (the time of day is not stored); the tags `import:buffer`,
`import:hootsuite` or `import:csv`, plus one row tag `ih-<16 hex>`.

Refusals:

| Status | `code` | When |
| --- | --- | --- |
| 409 | `file_changed` | Fingerprint missing or different from the file sent |
| 400 | `mapping_required` | No text column found and no mapping given (answer includes `headers`, `sampleRows`) |
| 400 | `date_order_required` | Slash dates are ambiguous and `dateOrder` was not sent |
| 400 | `invalid_mapping` | A named column is not in the file, or the mapping could not be read |
| 409 | `import_in_progress` | Another confirm for the same account is still running |

### Idempotency

Each created draft carries a tag `ih-<first 16 hex of SHA-256(fileFingerprint : row : content)>`. Before inserting, the account's
drafts are checked for those tags and matching rows are skipped as `already_imported`, so confirming the same file twice never
duplicates. Deleting an imported draft makes its row importable again. The tag is visible in the post's tag list.

### Per-request cap

One confirm creates at most 200 drafts. A longer file reports the rest in `remaining`; confirm again with the same file to
import the next batch (rows already imported are skipped).

### Plan and draft limits

The existing draft path (`POST /scheduled-posts/draft`) applies no plan or per-account draft cap, so this feature applies none
either; it reuses that path's rules instead of inventing new ones. The plan limits that matter (monthly post count, platform
rolling limits, platform text rules) apply later, when a draft is scheduled.

## Dates

Never guessed silently.

* `YYYY-MM-DD HH:mm` (optional seconds) and ISO (`T`, optional `Z` or offset) are read directly. A zone written in the cell wins
  over the request `timezone`; otherwise times are read in `timezone` (default `UTC`, stated in the response).
* Slash dates (`DD/MM/YYYY` or `MM/DD/YYYY`): if any first part is above 12 the file is day-first (`dmy`); if any second part is
  above 12 it is month-first (`mdy`); if every part is 12 or less, or the file contradicts itself, `dateOrder` is `ambiguous`.
  The preview then shows no usable date for those rows and the confirm requires `dateOrder` (`dmy` or `mdy`), else 400
  `date_order_required`.
* A time in the past, unreadable, or impossible (for example 31/02) is kept as no planned date. The draft is still created.
* Planned dates are suggestions. Drafts are always created unscheduled.

## Limits and safety

| Limit | Value | Answer |
| --- | --- | --- |
| Body | 2 MB | 413 `file_too_large` |
| Data rows | 500 | 400 `too_many_rows` |
| Columns | 50 | 400 `too_many_columns` |
| One cell | 20,000 characters | 400 `cell_too_long` |
| Encoding | UTF-8, with or without BOM | UTF-16 or other encodings: 415 `encoding_unsupported`, "save as CSV UTF-8" |
| Empty, header only, zip or binary file | | 400 `empty_file`, `header_only`, `not_text` |
| Unclosed quote | | 400 `malformed_csv` |
| Rate | 10 previews and 5 confirms per user per hour | 429 `rate_limited` |

* Supported CSV: RFC 4180 quoting (commas, CR and LF and escaped quotes inside quotes), delimiter auto-detected (`,` `;` or tab),
  ragged rows tolerated, blank lines skipped.
* Every cell is treated as data: control characters and bidirectional override characters are removed; nothing is evaluated or
  fetched. Cells starting with `=`, `+`, `-` or `@` are kept as plain text. This feature never writes a spreadsheet back out, so
  they are never re-exported; if a draft's text is ever exported to a spreadsheet elsewhere, that export must neutralise them.
* The file is read in memory and never stored. Logs carry counts only, never cell contents.

## Error shape

Every refusal is `{ "error": "<plain sentence>", "code": "<machine code>" }` plus the extra fields noted above.

## Turning it on

Set `CSV_MIGRATION_ENABLED=true` on the backend. No database migration is needed: drafts use the existing `scheduled_posts` table.

## Not covered

No visual picker, no media import (media columns are ignored), no support for Excel `.xlsx` files, no scheduling, approving or
publishing. The OpenAPI document and the MCP tools are hand written in this repository and do not need an entry for a human-only
route.
