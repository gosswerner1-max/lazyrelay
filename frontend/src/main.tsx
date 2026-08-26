import { StrictMode } from 'react'
import { createRoot, hydrateRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { restoreStoredConsent } from './components/CookieConsent.tsx'
import { ErrorBoundary } from './components/ErrorBoundary.tsx'

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
// static markup for the logged-out homepage and marks it with this
// attribute. Hydrating onto that markup lets the browser keep showing it
// immediately instead of blanking the page and re-rendering from scratch
// -- that swap-from-scratch is exactly the flash a plain createRoot().render()
// would cause here. Every other route (no prerendered markup, root starts
// empty) keeps the original createRoot behavior unchanged.
//
// Also requires pathname === "/": the .htaccess SPA fallback serves this
// SAME physical index.html (baked for the landing page only) for literally
// any unmatched path -- /login, /signup, /forgot-password, /contact all
// have no static file of their own, so a fresh load of any of those was
// hydrating the Login/Contact component tree onto the *landing page's*
// markup. That's a real structural mismatch, not a same-page conditional --
// confirmed live via a thrown "Minified React error #418" on every one of
// those routes' fresh loads (found 2026-08-26). The page still recovered
// (React discards the bad hydration and falls back to a full client
// render), but only after throwing and likely a visible content flash.
// Checking the URL here is cheap insurance: the baked snapshot is only ever
// valid for "/", so only attempt to hydrate onto it there.
if (root.hasAttribute('data-prerendered') && window.location.pathname === '/') {
  hydrateRoot(root, tree)
} else {
  createRoot(root).render(tree)
}
