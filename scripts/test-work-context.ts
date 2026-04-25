import assert from 'node:assert/strict'

import {
  matchWorktree,
  reduceWorkContextFromRaw,
} from '../src/renderer/src/workspace/work-context/reducer'
import {
  deriveAgentWorkContext,
  ingestWorktreeRawEvent,
} from '../src/renderer/src/workspace/work-context/tracker'
import type { WorktreeIdentity } from '../src/shared/types/git'
import type { WorktreeActivityState } from '../src/renderer/src/workspace/work-context/types'

const worktrees: WorktreeIdentity[] = [
  {
    path: '/repo',
    branch: 'main',
    head: 'aaa',
    detached: false,
  },
  {
    path: '/repo-feature',
    branch: 'feat/work',
    head: 'bbb',
    detached: false,
  },
]

const claudeToolEntry = (
  name: string,
  input: Record<string, unknown>,
  extra: Record<string, unknown> = {},
) => ({
  type: 'assistant',
  uuid: `uuid-${name}-${JSON.stringify(input)}`,
  parentUuid: null,
  message: {
    role: 'assistant',
    content: [
      {
        type: 'tool_use',
        id: `tool-${name}`,
        name,
        input,
      },
    ],
  },
  ...extra,
})

{
  const context = reduceWorkContextFromRaw(null, {
    type: 'worktree-state',
    sessionId: 's',
    worktreeSession: {
      worktreePath: '/repo-feature',
      worktreeBranch: 'feat/work',
    },
  }, worktrees, '/repo')

  assert.equal(context?.worktreePath, '/repo-feature')
  assert.equal(context?.branch, 'feat/work')
  assert.equal(context?.confidence, 'explicit')
}

{
  const context = reduceWorkContextFromRaw(null, {
    type: 'worktree-state',
    sessionId: 's',
    worktreeSession: null,
  }, worktrees, '/repo')

  assert.equal(context?.worktreePath, '/repo')
  assert.equal(context?.branch, 'main')
  assert.equal(context?.confidence, 'medium')
  assert.equal(context?.source, 'claude:worktree-state:exit')
}

{
  const exited = reduceWorkContextFromRaw(null, {
    type: 'worktree-state',
    sessionId: 's',
    worktreeSession: null,
  }, worktrees, '/repo')
  const afterRead = reduceWorkContextFromRaw(
    exited,
    claudeToolEntry('Read', { file_path: '/etc/hosts' }),
    worktrees,
    '/repo',
  )

  assert.deepEqual(afterRead, exited)
}

{
  const context = reduceWorkContextFromRaw(
    null,
    claudeToolEntry('Read', { file_path: '/repo-feature/src/app.ts' }),
    worktrees,
    '/repo',
  )

  assert.equal(context?.worktreePath, '/repo-feature')
  assert.equal(context?.branch, 'feat/work')
  assert.equal(context?.confidence, 'weak')
}

{
  const context = reduceWorkContextFromRaw(
    null,
    claudeToolEntry('Read', { file_path: '/tmp/outside.txt' }),
    worktrees,
    '/repo',
  )

  assert.equal(context, null)
}

{
  const context = reduceWorkContextFromRaw(null, {
    timestamp: '2026-04-24T00:00:00.000Z',
    type: 'event_msg',
    payload: {
      type: 'exec_command_end',
      call_id: 'call',
      cwd: '/repo-feature',
    },
  }, worktrees, '/repo')

  assert.equal(context?.worktreePath, '/repo-feature')
  assert.equal(context?.branch, 'feat/work')
  assert.equal(context?.confidence, 'strong')
}

{
  const context = reduceWorkContextFromRaw(null, {
    timestamp: '2026-04-24T00:00:00.000Z',
    type: 'response_item',
    payload: {
      type: 'local_shell_call',
      call_id: 'call',
      action: {
        working_directory: '/repo-feature',
      },
    },
  }, worktrees, '/repo')

  assert.equal(context?.worktreePath, '/repo-feature')
  assert.equal(context?.branch, 'feat/work')
  assert.equal(context?.confidence, 'medium')
}

{
  const context = reduceWorkContextFromRaw(null, {
    type: 'assistant',
    uuid: 'cwd',
    parentUuid: null,
    cwd: '/repo-feature',
    gitBranch: 'feat/work',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'ok' }],
    },
  }, worktrees, '/repo')

  assert.equal(context?.worktreePath, '/repo-feature')
  assert.equal(context?.branch, 'feat/work')
  assert.equal(context?.confidence, 'medium')
  assert.equal(context?.source, 'claude:entry.cwd')
}

{
  let state: WorktreeActivityState | null = null
  state = ingestWorktreeRawEvent({
    state,
    raw: {
      timestamp: '2026-04-24T16:51:13.000Z',
      type: 'event_msg',
      payload: {
        type: 'exec_command_end',
        call_id: 'status',
        cwd: '/repo-feature',
        command: ['git', 'status', '--short'],
      },
    },
    worktrees,
    sessionCwd: '/repo',
  })
  state = ingestWorktreeRawEvent({
    state,
    raw: {
      timestamp: '2026-04-24T16:51:30.000Z',
      type: 'event_msg',
      payload: {
        type: 'exec_command_end',
        call_id: 'commit',
        cwd: '/repo-feature',
        command: ['git', 'commit', '-m', 'add workflow commands'],
      },
    },
    worktrees,
    sessionCwd: '/repo',
  })
  state = ingestWorktreeRawEvent({
    state,
    raw: {
      timestamp: '2026-04-24T16:51:45.000Z',
      type: 'event_msg',
      payload: {
        type: 'exec_command_end',
        call_id: 'push',
        cwd: '/repo-feature',
        command: ['git', 'push', '-u', 'origin', 'feat/work'],
      },
    },
    worktrees,
    sessionCwd: '/repo',
  })
  state = ingestWorktreeRawEvent({
    state,
    raw: {
      timestamp: '2026-04-24T16:56:49.000Z',
      type: 'event_msg',
      payload: {
        type: 'exec_command_end',
        call_id: 'pull-main',
        cwd: '/repo',
        command: ['git', 'pull', '--ff-only'],
      },
    },
    worktrees,
    sessionCwd: '/repo',
  })

  assert.equal(deriveAgentWorkContext(state)?.worktreePath, '/repo-feature')
  assert.equal(state.active?.worktreePath, '/repo')
  assert.equal(state.primary?.worktreePath, '/repo-feature')
  assert.equal(state.primary?.branch, 'feat/work')
}

{
  const context = reduceWorkContextFromRaw(null, {
    type: 'assistant',
    uuid: 'cwd-outside',
    parentUuid: null,
    cwd: '/tmp/outside',
    gitBranch: 'tmp',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'ok' }],
    },
  }, worktrees, '/repo')

  assert.equal(context, null)
}

{
  assert.equal(matchWorktree('/repo/src/index.ts', worktrees)?.path, '/repo')
  assert.equal(matchWorktree('/repo-feature/src/index.ts', worktrees)?.path, '/repo-feature')
  assert.equal(matchWorktree('/repo-feature-long/src/index.ts', worktrees), null)
}

console.log('work-context reducer tests passed')
