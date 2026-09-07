import { StrictMode } from 'react'
import { createRoot, hydrateRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { restoreStoredConsent } from './components/CookieConsent.tsx'
import { ErrorBoundary } from './components/ErrorBoundary.tsx'

// No unconditional PostHog init here on purpose -- restoreStoredConsent()
// below only initializes it (via setPostHogConsent) if a returning visitor
// already granted analytics consent in a prior session. A fresh visitor
// gets zero PostHog footprint, not even an inert cookie, until they
// actually choose. See lib/posthog.ts for the full reasoning.
restoreStoredConsent()

const root = document.getElementById('root')!
const tree = (
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>
)

// The prerender build step (scripts/prerender.mjs) fills #root with real
// static markup for a fixed set of public routes and marks it with this
// attribute. Hydrating onto that markup lets the browser keep showing it
// immediately instead of blanking the page and re-rendering from scratch
// -- that swap-from-scratch is exactly the flash a plain createRoot().render()
// would cause here. Every other route (no prerendered markup, root starts
// empty) keeps the original createRoot behavior unchanged.
//
// Also requires the path to be one of the routes that script actually
// prerenders: each of those has its own dedicated dist/<route>/index.html
// (added 2026-09-07 for /privacy, /terms, /dpa alongside the original "/"),
// so what's baked into #root always matches what this same pathname would
// render anyway -- unlike routes with no static file of their own, where
// the .htaccess SPA fallback serves the *homepage's* baked index.html for
// literally any unmatched path (/login, /signup, /forgot-password, /contact
// among them). Hydrating one component tree onto another route's markup is
// a real structural mismatch, not a same-page conditional -- confirmed live
// via a thrown "Minified React error #418" on every one of those routes'
// fresh loads (found 2026-08-26) before this check existed. The page still
// recovered (React discards the bad hydration and falls back to a full
// client render), but only after throwing and likely a visible content
// flash. Checking the URL here is cheap insurance: only attempt to hydrate
// where the baked snapshot is guaranteed to be for the exact page loading.
const PRERENDERED_PATHS = ['/', '/privacy', '/terms', '/dpa']

// /login and /signup were deliberately NOT added to this list despite also
// getting a real first-visit blank-flash finding (Browser-Aware Web Design
// audit, 2026-08-26) -- attempting the same prerender-and-bake technique for
// them hit a real, structural blocker: Login.tsx renders a live Cloudflare
// Turnstile widget, which needs a fresh per-visitor challenge session and
// which actively appears to detect/log against headless/automated browsers
// (the exact thing puppeteer-core, which drives scripts/prerender.mjs, is).
// Baking a stale captcha challenge into a static snapshot wouldn't be valid
// for a real visitor anyway, and forcing the console-error safety check to
// ignore Turnstile's own noise would mean silently swallowing a real
// bot-detection signal on a security-sensitive auth flow. See
// scripts/prerender.mjs's header comment for the full writeup.
if (root.hasAttribute('data-prerendered') && PRERENDERED_PATHS.includes(window.location.pathname)) {
  hydrateRoot(root, tree)
} else {
  createRoot(root).render(tree)
}
