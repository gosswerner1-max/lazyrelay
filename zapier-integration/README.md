# LazyRelay Zapier Integration (v1)

A private Zapier CLI app wrapping LazyRelay's existing public API
(`backend/src/http/routes.ts`) — no backend changes required. See
`C:\Users\werne\.claude\plans\humble-moseying-tiger.md` for the full plan
and reasoning.

## What it does

- **Auth**: connects with a LazyRelay API key (Settings → API Keys in the
  dashboard, paid tiers only).
- **Trigger — New Post Published**: polls for posts that have been
  confirmed live (Proof-of-Publish verified).
- **Action — Upload Media**: uploads an image/video, returns a URL.
- **Action — Schedule Post**: schedules (or immediately posts) content to a
  connected social account.

## Setup (run these yourself — this needs your own Zapier login)

1. Install dependencies:
   ```
   cd zapier-integration
   npm install
   ```
2. Copy `.env.example` to `.env` and fill in a real API key from your
   LazyRelay dashboard (Settings → API Keys).
3. Run the tests:
   ```
   npm test
   ```
4. Log into your Zapier developer account from this folder (opens a
   browser):
   ```
   npx zapier-platform-cli login
   ```
5. Register the app under your account (one-time; creates `.zapierapprc`,
   not committed to git):
   ```
   npx zapier-platform-cli register "LazyRelay"
   ```
6. Push this version to Zapier:
   ```
   npx zapier-platform-cli push
   ```
7. In Zapier's own UI, go to your app's "Test" tab, connect a real account
   with a real API key, and build one live Zap end to end (e.g. New Post
   Published → a Slack message) to confirm it actually works, not just
   that it typechecks.

This ships as a **private integration** — visible only to you (and anyone
you explicitly invite) until you separately decide to submit it for
Zapier's public app-directory review.
