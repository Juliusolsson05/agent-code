import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

// Keep the actual browser acceptance test in the ordinary deterministic suite.
// The child owns a hidden Electron app and temporary filesystem, and its entry
// fixtures import the production installer, IPC, scheme and React bridge. Running
// those assertions inside Electron is necessary: happy-dom has no custom-scheme
// process/origin/CSP boundary and would bless a broken packaged handshake.
it('runs installed extension startup, storage, denial and recovery through real Electron frames', async () => {
  const script = fileURLToPath(new URL('../../../scripts/check-extension-frames.mjs', import.meta.url))
  const result = await promisify(execFile)(process.execPath, [script], {
    // Vitest itself stays in test mode. Only the isolated bundler/browser child
    // uses production mode so Vite's JSX transform and React's runtime agree;
    // inheriting NODE_ENV=test selected jsxDEV with the production React build.
    env: { ...process.env, NODE_ENV: 'production' },
    maxBuffer: 4 * 1024 * 1024,
    timeout: 360_000,
  })
  expect(result.stdout).toContain('Extension Electron integration checks passed')
  console.info(result.stdout.trim())
}, 370_000)

it('keeps one managed runtime across commands, view requests, updates and uninstall', async () => {
  const script = fileURLToPath(new URL('../../../scripts/check-extension-frames.mjs', import.meta.url))
  const result = await promisify(execFile)(process.execPath, [script, '--runtime-only'], {
    env: { ...process.env, NODE_ENV: 'production' }, maxBuffer: 4 * 1024 * 1024, timeout: 70_000,
  })
  expect(result.stdout).toContain('Extension managed runtime integration checks passed')
  console.info(result.stdout.trim())
}, 75_000)
