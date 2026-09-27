import { expect, it } from 'vitest'

// #1212: under Node 25 the global localStorage was Node's half-initialised Web
// Storage (no clear, reads undefined) instead of happy-dom's.
// testing/setup/renderer.ts installs a working one; this checks the renderer
// test environment really has it.
it('leaves the test environment with a working storage', () => {
  expect(typeof window.localStorage.clear).toBe('function')
  window.localStorage.setItem('probe', '1')
  expect(window.localStorage.getItem('probe')).toBe('1')
  window.localStorage.clear()
})
