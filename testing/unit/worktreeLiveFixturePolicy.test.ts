import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import { findRejectedWorktreeLiveFixtureKeys } from '../../scripts/worktree-live-fixture-policy'

const FIXTURES = [
  'claude-cwd-tool-branch-conflict.json',
  'codex-0151-worktree-window.json',
  'codex-proxy-exact-identity-zstd.json',
  'codex-live-channel-gap.json',
  'git-worktree-identities.json',
]

describe('worktree live fixture object-key privacy policy', () => {
  it('accepts every reviewed checked-in fixture key', () => {
    for (const name of FIXTURES) {
      const value = JSON.parse(readFileSync(resolve(
        process.cwd(),
        'testing/fixtures/worktree-live-attribution',
        name,
      ), 'utf8')) as unknown
      expect(findRejectedWorktreeLiveFixtureKeys(value), name).toEqual([])
    }
  })

  it('rejects arbitrary prose even when it is hidden in a numeric-valued key', () => {
    // WHY the value is deliberately non-string: the existing value scanner
    // already rejects private prose in strings. This is the bypass found in
    // review—mapCounts can promote an untrusted channel label into an object
    // key whose innocent number otherwise passes every publication check.
    expect(findRejectedWorktreeLiveFixtureKeys({
      channelCounts: { 'private prompt promoted to a key': 1 },
    })).toEqual(['channelCounts.private prompt promoted to a key'])
  })
})
