import assert from 'node:assert/strict'

import {
  collectWorktreeActivitySummaries,
} from '../src/main/worktreeActivity/WorktreeActivityIndex'
import type { WorktreeActivityIndexFile } from '../src/main/worktreeActivity/types'
import type { WorktreeIdentity } from '../src/shared/types/git'

const index: WorktreeActivityIndexFile = {
  version: 2,
  updatedAt: 1,
  transcripts: {
    '/tmp/transcript.jsonl': {
      file: '/tmp/transcript.jsonl',
      provider: 'claude',
      providerSessionId: 'session-a',
      cwd: '',
      mtimeMs: 10,
      size: 100,
      indexedAt: 20,
      events: [
        {
          path: '/repo-a/src/file.ts',
          branch: null,
          ts: 1000,
          kind: 'file-write',
          source: 'tool:Edit:path',
          primaryWeight: 9,
        },
        {
          path: '/repo-b/src/file.ts',
          branch: null,
          ts: 2000,
          kind: 'git-commit',
          source: 'codex:exec_command_end.cwd',
          primaryWeight: 12,
        },
      ],
    },
  },
}

const repoA: WorktreeIdentity[] = [
  { path: '/repo-a', branch: 'feat/a', head: 'aaa', detached: false },
]
const repoB: WorktreeIdentity[] = [
  { path: '/repo-b', branch: 'feat/b', head: 'bbb', detached: false },
]

const summaryA = collectWorktreeActivitySummaries(index, repoA)
assert.equal(summaryA.length, 1)
assert.equal(summaryA[0]?.worktreePath, '/repo-a')
assert.equal(summaryA[0]?.lastActivityAt, 1000)
assert.equal(summaryA[0]?.eventCounts.writes, 1)

const summaryB = collectWorktreeActivitySummaries(index, repoB)
assert.equal(summaryB.length, 1)
assert.equal(summaryB[0]?.worktreePath, '/repo-b')
assert.equal(summaryB[0]?.lastActivityAt, 2000)
assert.equal(summaryB[0]?.eventCounts.commits, 1)

console.log('worktree activity index tests passed')
