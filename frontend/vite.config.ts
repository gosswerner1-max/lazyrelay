import { defineConfig, configDefaults } from 'vitest/config'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test-setup.ts'],
    // Playwright owns e2e/ (its own *.spec.ts files, run via `npm run
    // test:e2e`) -- without this, Vitest's default include pattern picks
    // them up too and fails immediately, since they call test.describe()
    // from @playwright/test, not vitest. Spreading configDefaults.exclude
    // keeps Vitest's own default excludes (node_modules, dist, etc.).
    exclude: [...configDefaults.exclude, 'e2e/**'],
    // Vitest replaces every .css file with an empty module. The Custom Developer Keys stylesheet is read as text by
    // one test (a guard that its rules stay inside .byok-panels), so this one file, and only this one, is let through.
    css: { include: [/byok-panels\.css/] },
  },
})
