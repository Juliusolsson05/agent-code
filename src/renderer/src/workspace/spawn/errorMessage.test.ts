import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'

import { curatedSpawnMessage, sessionSpawnErrorMessage } from './errorMessage'

// #1286 review B (steering q22): this string is what session.ts throws for
// every failed spawn, and newTab, reload, provider switch, rewind, the
// capability reload and the orchestration tool error all show it. It must
// never be the raw provider exception.
const recorded = (JSON.parse(readFileSync(join(import.meta.dirname,
  '../../../../../testing/fixtures/spawn-failure/posix-spawnp-2026-09-23.json'), 'utf8')) as { reason: string }).reason

it('flattens a raw spawn rejection to the safe sentence', () => {
  const message = sessionSpawnErrorMessage('codex', new Error(recorded), false, '/repo')
  expect(message).toBe('Session failed to start. Check provider setup and retry.')
  expect(message).not.toContain('posix_spawnp')
})

it('keeps main\'s curated missing-folder text, without the IPC wrapper', () => {
  const relayed = "Error invoking remote method 'session:spawn': MissingWorkspaceDirectoryError: Workspace folder is missing: /repo/.worktrees/gone"
  expect(sessionSpawnErrorMessage('claude', new Error(relayed), true, '/repo/.worktrees/gone')).toBe('Workspace folder is missing: /repo/.worktrees/gone')
})

it('keeps the actionable Claude proxy rewrite', () => {
  expect(sessionSpawnErrorMessage('claude', new Error('Timed out waiting for mitmproxy'), true, '/repo')).toContain('Claude proxy startup failed')
})

// #1286 review C2: main's ProviderCliNotFoundError is curated and names the
// fix (File › Setup…). It arrives wrapped by IPC and must survive as itself.
it('keeps main\'s curated CLI-not-found sentence, without the IPC wrapper', () => {
  const relayed = "Error invoking remote method 'session:spawn': ProviderCliNotFoundError: claude CLI not found. Open Setup (File › Setup…) to install it or enter its path."
  expect(sessionSpawnErrorMessage('claude', new Error(relayed), false, '/repo')).toBe('claude CLI not found. Open Setup (File › Setup…) to install it or enter its path.')
})

// #1286 review C round 2: the folder text used to be every byte after the
// prefix, so a provider exception that contained the prefix and then a URL
// or token passed it through. The folder named is now the one the renderer
// asked to spawn in, never the error's own tail.
it('never passes anything after the missing-folder prefix through', () => {
  const tainted = 'posix_spawnp failed env=ANTHROPIC_API_KEY=sk-ant-secret Workspace folder is missing: /tmp\nhttps://user:pass@proxy'
  const sameLine = 'Workspace folder is missing: /repo ANTHROPIC_API_KEY=sk-ant-secret MCP_TOKEN=scoped'
  expect(sessionSpawnErrorMessage('claude', new Error(tainted), true, '/tmp')).toBe('Workspace folder is missing: /tmp')
  expect(sessionSpawnErrorMessage('codex', new Error(sameLine), false, '/repo')).toBe('Workspace folder is missing: /repo')
  expect(curatedSpawnMessage(sameLine, '/repo')).toBe('Workspace folder is missing: /repo')
})

// #1286 review C round 2: the CLI sentence's kind must be a provider id,
// not any lowercase token placed before the suffix.
it('shows the CLI sentence only for a known provider', () => {
  expect(curatedSpawnMessage('sk-ant-api03-aaaaaaaaaaaaaaaa CLI not found. Open Setup (File › Setup…) to install it or enter its path. TOKEN=AFTER', '/repo')).toBeNull()
  expect(curatedSpawnMessage("Error invoking remote method 'session:spawn': ProviderCliNotFoundError: opencode CLI not found. Open Setup (File › Setup…) to install it or enter its path.", '/repo'))
    .toBe('opencode CLI not found. Open Setup (File › Setup…) to install it or enter its path.')
})
