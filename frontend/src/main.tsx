import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { restoreStoredConsent } from './components/CookieConsent.tsx'
import { ErrorBoundary } from './components/ErrorBoundary.tsx'

restoreStoredConsent()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
)
