# Publishing @lazyrelay/mcp-server

**Read this before running `npm publish` by hand. There is a working, automated way to do this — use it, don't reach for a stored token.**

## The working method (use this)

1. Bump the version in `package.json` (e.g. `npm version patch --no-git-tag-version`).
2. Commit and push to `main`, touching something under `mcp-server/`.
3. That's it. `.github/workflows/publish-mcp-server.yml` builds and publishes automatically via **npm trusted publishing (OIDC)** — no token anywhere, nothing to leak, nothing that expires.

The workflow only actually publishes if the version you bumped to differs from what's already live on npm (`npm view @lazyrelay/mcp-server version`) — so pushing without a real version bump is a harmless no-op, not an error. If you want to watch it run: `gh run list --repo gosswerner1-max/lazyrelay --workflow=publish-mcp-server.yml`.

Only bump the version when there's a real reason — a real code or doc change, not a version number for its own sake. If you're validating the pipeline itself rather than shipping real content, say so explicitly in the commit message (see commit `0b1ff1f`, the `0.1.2` release, for the pattern).

## The dead end — don't reach for this

`ops/config/credentials.js::getNpmAccessToken()` reads a stored npm access token from the gitignored `ops/config/credentials.local.json`. **This was how `0.1.0` (2026-08-07) and `0.1.1` (2026-08-17) were published, and it still works today, but don't use it for new work:**

- It's a "bypass 2FA" granular access token — npm is actively restricting this exact token class. Account-management actions (including revoking tokens — even revoking *itself*) were already blocked as of 2026-07-31 (confirmed with a real attempt: `npm token revoke` on this token returns `403 Forbidden`, citing the restriction directly). Direct publishing itself loses this capability entirely around January 2027.
- Trusted publishing (above) needs no token, doesn't expire, and can't leak, since there's nothing sitting on disk to leak.

If `getNpmAccessToken()` ever returns `null` going forward, that's expected, not a bug to fix — the token may have been deliberately revoked once trusted publishing was proven working (2026-08-17). Don't regenerate a replacement token as a workaround; use the GitHub Actions path instead.

## If the workflow itself needs changing

Trusted publisher is configured on npmjs.com: `@lazyrelay/mcp-server` package → Settings → Trusted Publisher → GitHub Actions → `gosswerner1-max` / `lazyrelay` / `publish-mcp-server.yml`, permission `npm publish` only. If you rename the workflow file or move the repo, that config has to be updated to match — it's tied to the exact filename and repo, and only Werner can change it (npm gates changes to this behind step-up 2FA on his account, deliberately — a leaked/compromised session still can't quietly redirect where publishes are trusted from).
