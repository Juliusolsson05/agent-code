import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import { asRecord } from '@shared/lib/asRecord.js'
import { extractWorktreeActivityEvents } from '@shared/work-context/extractors.js'
import {
  deriveAgentWorkContext,
  ingestWorktreeRawEvent,
} from '@shared/work-context/tracker.js'
import type {
  WorktreeActivityState,
  WorktreeIdentity,
} from '@shared/work-context/types.js'

type RecordedFixture = {
  records: Array<Record<string, unknown>>
}

type LiveAttributionFixture = RecordedFixture & {
  git: {
    main: { path: string; branch: string }
    grid: { path: string; branch: string }
  }
}

const MAIN_CHECKOUT = '/fixture/project-1'
const LINKED_WORKTREE = `${MAIN_CHECKOUT}/.worktrees/worktree-1`

function loadRecordedFixture(name: string): RecordedFixture {
  // WHY read the checked-in JSON instead of reproducing its object shape here:
  // these regressions exist specifically because plausible provider literals
  // omitted the current carriers. The fixture is the evidence boundary; if it
  // changes, every consumer below must replay the same reviewed recording.
  const path = resolve(
    process.cwd(),
    'testing',
    'fixtures',
    'worktree-context',
    name,
  )
  const parsed = asRecord(JSON.parse(readFileSync(path, 'utf8')))
  if (!parsed || !Array.isArray(parsed.records)) {
    throw new Error(`recorded fixture ${name} has no records array`)
  }
  return { records: parsed.records as Array<Record<string, unknown>> }
}

function loadLiveAttributionFixture(name: string): LiveAttributionFixture {
  // WHY this corpus has a separate root from the older grammar fixtures: its
  // source is the complaint-time live session, proxy, and Git state captured
  // at one fixed cutoff. Folding it into `worktree-context` would erase that
  // cross-source provenance and make a future hand-authored provider literal
  // look equivalent to the recording that actually reproduced #685.
  const path = resolve(
    process.cwd(),
    'testing',
    'fixtures',
    'worktree-live-attribution',
    name,
  )
  const parsed = asRecord(JSON.parse(readFileSync(path, 'utf8')))
  const git = asRecord(parsed?.git)
  const main = asRecord(git?.main)
  const grid = asRecord(git?.grid)
  if (
    !parsed || !Array.isArray(parsed.records) || !main || !grid ||
    typeof main.path !== 'string' || typeof main.branch !== 'string' ||
    typeof grid.path !== 'string' || typeof grid.branch !== 'string'
  ) {
    throw new Error(`recorded live-attribution fixture ${name} is malformed`)
  }
  return parsed as unknown as LiveAttributionFixture
}

function identity(path: string, branch: string): WorktreeIdentity {
  return { path, branch, head: null, detached: false }
}

function replay(
  records: Array<Record<string, unknown>>,
  worktrees: WorktreeIdentity[],
  sessionCwd: string,
): WorktreeActivityState | null {
  let state: WorktreeActivityState | null = null
  for (const raw of records) {
    state = ingestWorktreeRawEvent({ state, raw, worktrees, sessionCwd })
  }
  return state
}

describe('recorded work-context provider contracts', () => {
  it('[claude-cwd-tool-branch-conflict] keeps same-envelope direct work active', () => {
    const fixture = loadLiveAttributionFixture(
      'claude-cwd-tool-branch-conflict.json',
    )
    const worktrees = [
      identity(fixture.git.main.path, fixture.git.main.branch),
      identity(fixture.git.grid.path, fixture.git.grid.branch),
    ]

    // WHY the prefix is the recorded contradiction, not a reduced object we
    // invented: its tool writes under the grid worktree while the enclosing
    // assistant envelope still reports the main checkout. Direct activity is
    // the active-location fact; envelope cwd is only conversation affinity.
    const state = replay(fixture.records.slice(0, 1), worktrees, fixture.git.main.path)

    expect(state?.active).toMatchObject({
      worktreePath: fixture.git.grid.path,
      branch: fixture.git.grid.branch,
      source: 'tool:Write:path',
    })
  })

  it('[claude-cwd-tool-branch-conflict] uses Git branch for a matched checkout', () => {
    const fixture = loadLiveAttributionFixture(
      'claude-cwd-tool-branch-conflict.json',
    )
    const worktrees = [
      identity(fixture.git.main.path, fixture.git.main.branch),
      identity(fixture.git.grid.path, fixture.git.grid.branch),
    ]

    // The second captured envelope has both cwd and tool path inside grid but
    // retains the main branch string. Once the path matches a Git worktree,
    // that provider branch is stale diagnostic metadata, not naming authority.
    const state = replay(fixture.records.slice(1), worktrees, fixture.git.main.path)

    expect(state?.active).toMatchObject({
      worktreePath: fixture.git.grid.path,
      branch: fixture.git.grid.branch,
    })
    expect(state?.primary).toMatchObject({
      worktreePath: fixture.git.grid.path,
      branch: fixture.git.grid.branch,
    })
  })

  it('[claude-cwd-tool-branch-conflict] does not relabel a detached match', () => {
    const fixture = loadLiveAttributionFixture(
      'claude-cwd-tool-branch-conflict.json',
    )
    const worktrees: WorktreeIdentity[] = [
      identity(fixture.git.main.path, fixture.git.main.branch),
      {
        path: fixture.git.grid.path,
        branch: null,
        head: null,
        detached: true,
      },
    ]

    // This is an explicit policy mutation of the recorded Git row, not a claim
    // that the complaint-time checkout was detached. It exercises the null half
    // of the approved rule: Git's matched branch authority includes "no branch"
    // and must not fall back to the stale provider main string.
    const state = replay(fixture.records.slice(1), worktrees, fixture.git.main.path)

    expect(state?.active).toMatchObject({
      worktreePath: fixture.git.grid.path,
      branch: null,
    })
    expect(state?.primary).toMatchObject({
      worktreePath: fixture.git.grid.path,
      branch: null,
    })
  })

  it('[codex-main-to-worktree] recognizes every observed current Codex carrier', () => {
    const { records } = loadRecordedFixture('codex-main-to-worktree.json')
    const sessionMeta = extractWorktreeActivityEvents(records[0])
    const turnContext = extractWorktreeActivityEvents(records[1])
    const command = extractWorktreeActivityEvents(records[2])
    const threadSettings = extractWorktreeActivityEvents(records[3])
    const fileChange = extractWorktreeActivityEvents(records[4])
    const nextTurnContext = extractWorktreeActivityEvents(records[5])
    const changes = asRecord(asRecord(asRecord(records[4].payload)?.item)?.changes)
    if (!changes) throw new Error('recorded FileChange lost its changes object')

    // Soft assertions keep one missing carrier from hiding the rest of the
    // recorded grammar. Stage 3 can then turn the suite green one provider
    // shape at a time without guessing which unreported cases remain.
    expect.soft(sessionMeta).toEqual([
      expect.objectContaining({
        kind: 'session-cwd',
        path: MAIN_CHECKOUT,
        branch: 'fixture/branch-1',
      }),
    ])
    expect.soft(turnContext).toEqual([
      expect.objectContaining({ kind: 'session-cwd', path: MAIN_CHECKOUT }),
    ])
    expect.soft(command).toEqual([
      expect.objectContaining({
        kind: 'command',
        path: `file://${MAIN_CHECKOUT}`,
      }),
    ])
    expect.soft(threadSettings).toEqual([
      expect.objectContaining({
        kind: 'session-cwd',
        path: MAIN_CHECKOUT,
        active: false,
      }),
    ])
    expect.soft(fileChange.map(event => ({ kind: event.kind, path: event.path })))
      .toEqual(Object.keys(changes).map(path => ({ kind: 'file-write', path })))
    expect.soft(nextTurnContext).toEqual([
      expect.objectContaining({
        kind: 'session-cwd',
        path: MAIN_CHECKOUT,
        active: false,
      }),
    ])
  })

  it('[codex-main-to-worktree] moves recorded activity only when the final worktree write arrives', () => {
    const { records } = loadRecordedFixture('codex-main-to-worktree.json')
    const worktrees = [
      identity(MAIN_CHECKOUT, 'fixture/branch-1'),
      identity(LINKED_WORKTREE, 'fixture/worktree-branch'),
    ]

    const beforeWrite = replay(records.slice(0, 4), worktrees, MAIN_CHECKOUT)
    const afterWrite = replay(records.slice(0, 5), worktrees, MAIN_CHECKOUT)
    const afterNextTurn = replay(records, worktrees, MAIN_CHECKOUT)

    // WHY compare the prefix and complete recording: this is the mechanical
    // proof that the failing expectation is driven by the captured FileChange,
    // not by a hand-authored active/primary state that already contains the
    // answer the implementation is supposed to derive.
    expect({
      before: deriveAgentWorkContext(beforeWrite)?.worktreePath ?? null,
      afterActive: afterWrite?.active?.worktreePath ?? null,
      afterPrimary: afterWrite?.primary?.worktreePath ?? null,
      afterNextTurnActive: afterNextTurn?.active?.worktreePath ?? null,
    }).toEqual({
      before: MAIN_CHECKOUT,
      afterActive: LINKED_WORKTREE,
      afterPrimary: LINKED_WORKTREE,
      afterNextTurnActive: LINKED_WORKTREE,
    })
  })

  it('[codex-mcp-child-cwd] does not attribute a child agent cwd to the caller', () => {
    const { records } = loadRecordedFixture('codex-mcp-child-cwd.json')

    expect(extractWorktreeActivityEvents(records[0])).toEqual([])
  })

  it('[claude-worktree-context] preserves recorded enter and conversation cwd behavior', () => {
    const { records } = loadRecordedFixture('claude-worktree-context.json')
    const worktrees = [
      identity(MAIN_CHECKOUT, 'fixture/branch-1'),
      identity(LINKED_WORKTREE, 'fixture/branch-1'),
    ]

    const entered = replay(records.slice(0, 2), worktrees, MAIN_CHECKOUT)
    const currentConversation = extractWorktreeActivityEvents(records[2])

    expect(entered?.active?.worktreePath).toBe(LINKED_WORKTREE)
    expect(entered?.primary?.worktreePath).toBe(LINKED_WORKTREE)
    expect(currentConversation).toEqual([
      expect.objectContaining({
        kind: 'session-cwd',
        path: '/fixture/project-2',
        branch: 'fixture/branch-2',
      }),
    ])
  })
})
