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
if (root.hasAttribute('data-prerendered')) {
  hydrateRoot(root, tree)
} else {
  createRoot(root).render(tree)
}
