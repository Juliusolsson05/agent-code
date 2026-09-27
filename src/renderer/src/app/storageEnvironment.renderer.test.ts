import { expect, it } from 'vitest'

// #1212: under Node 25 the global localStorage was Node's half-initialised Web
// Storage (no clear, reads undefined) instead of happy-dom's.
// testing/setup/renderer.ts installs a working one; this checks the renderer
// test environment really has it.
// Review c of #1408: with --localstorage-file, Node 25's storage is
// file-backed and was kept, so a file could start with another process's keys.
it('starts every test file with an empty DOM storage', () => {
  expect(window.localStorage.length).toBe(0)
  expect(window.sessionStorage.length).toBe(0)
})

it('leaves the test environment with a working storage', () => {
  expect(typeof window.localStorage.clear).toBe('function')
  window.localStorage.setItem('probe', '1')
  expect(window.localStorage.getItem('probe')).toBe('1')
  window.localStorage.clear()
})
