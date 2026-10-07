# Publishing n8n-nodes-lazyrelay

**Read this before running `npm publish` by hand. There is a working, automated way to do this — use it, don't reach for a stored token.**

## The working method (use this)

1. Bump the version in `package.json` (e.g. `npm version patch --no-git-tag-version`).
2. Commit and push to `main`, touching something under `n8n-nodes-lazyrelay/`.
3. That's it. `.github/workflows/publish-n8n-node.yml` installs, builds, runs the tests and publishes automatically via **npm trusted publishing (OIDC)** — no token anywhere, nothing to leak, nothing that expires. Every release carries a signed provenance statement (`npm publish --provenance`).

The workflow only actually publishes if the version you bumped to is not already in `npm view n8n-nodes-lazyrelay versions` — so pushing without a real version bump is a harmless no-op, not an error, and it can never re-publish or overwrite a version that is already live. If you want to watch it run: `gh run list --repo gosswerner1-max/lazyrelay --workflow=publish-n8n-node.yml`.

Only bump the version when there's a real reason — a real code or doc change, not a version number for its own sake. The n8n community-node verification process reads the published package, so a release is also what n8n sees.

This is how `0.1.1` (2026-10-01) was published. `0.1.0` (2026-09-30) was published by hand before the workflow existed.

## The dead end — don't reach for this

Don't publish by hand with a stored npm token. npm is restricting the "bypass 2FA" granular tokens that made that possible (account-management actions already blocked since 2026-07-31; direct publishing goes around January 2027). Trusted publishing (above) needs no token, doesn't expire, and can't leak. See `mcp-server/PUBLISHING.md` for the full history.

## npm-side setup (one-time, Werner, in the browser)

Already done for this package — `0.1.1` went out through it. Recorded here so it can be redone if the repo moves or the workflow file is renamed, because npm ties the trust to the exact repo + filename:

1. Sign in at npmjs.com and open https://www.npmjs.com/package/n8n-nodes-lazyrelay
2. Click **Settings** (top right of the package page)
3. Scroll to **Publishing access** → **Trusted Publisher** → click **GitHub Actions**
4. Fill in exactly these three values:

| Field | Value |
|---|---|
| Organization or user | `gosswerner1-max` |
| Repository | `lazyrelay` |
| Workflow filename | `publish-n8n-node.yml` |
| Environment name | *(leave empty — the workflow uses no environment)* |

5. Save. npm will ask for 2FA on this change — that's deliberate, only Werner can redirect where publishes are trusted from.

While you're in Settings, set **Publishing access** to *"Require two-factor authentication and disallow tokens"* so trusted publishing is the **only** way this package can be published.
