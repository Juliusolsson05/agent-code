import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

import { installWorkingStorage } from './storage'

// Node 25's half-initialised Web Storage would otherwise shadow happy-dom's
// (#1212); see installWorkingStorage.
installWorkingStorage(globalThis)

// WHY this file exists even though today's renderer smoke test barely needs
// setup:
//
// Renderer tests should have one official place for DOM matchers and browser
// shims. Without that convention, future tests will each invent their own
// local setup and we will recreate the same "random scripts with local magic"
// problem that this testing rewrite is removing.
afterEach(() => {
  cleanup()
})
