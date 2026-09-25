import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'

import { sessionSpawnErrorMessage } from './errorMessage'

// #1286 review B (steering q22): this string is what session.ts throws for
// every failed spawn, and newTab, reload, provider switch, rewind, the
// capability reload and the orchestration tool error all show it. It must
// never be the raw provider exception.
const recorded = (JSON.parse(readFileSync(join(import.meta.dirname,
  '../../../../../testing/fixtures/spawn-failure/posix-spawnp-2026-09-23.json'), 'utf8')) as { reason: string }).reason

it('flattens a raw spawn rejection to the safe sentence', () => {
  const message = sessionSpawnErrorMessage('codex', new Error(recorded), false)
  expect(message).toBe('Session failed to start. Check provider setup and retry.')
  expect(message).not.toContain('posix_spawnp')
})

it('keeps main\'s curated missing-folder text, without the IPC wrapper', () => {
  const relayed = "Error invoking remote method 'session:spawn': MissingWorkspaceDirectoryError: Workspace folder is missing: /repo/.worktrees/gone"
  expect(sessionSpawnErrorMessage('claude', new Error(relayed), true)).toBe('Workspace folder is missing: /repo/.worktrees/gone')
})

it('keeps the actionable Claude proxy rewrite', () => {
  expect(sessionSpawnErrorMessage('claude', new Error('Timed out waiting for mitmproxy'), true)).toContain('Claude proxy startup failed')
})

// #1286 review C2: main's ProviderCliNotFoundError is curated and names the
// fix (File › Setup…). It arrives wrapped by IPC and must survive as itself.
it('keeps main\'s curated CLI-not-found sentence, without the IPC wrapper', () => {
  const relayed = "Error invoking remote method 'session:spawn': ProviderCliNotFoundError: claude CLI not found. Open Setup (File › Setup…) to install it or enter its path."
  expect(sessionSpawnErrorMessage('claude', new Error(relayed), false)).toBe('claude CLI not found. Open Setup (File › Setup…) to install it or enter its path.')
})
