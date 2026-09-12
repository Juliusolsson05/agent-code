import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import type { PersistedWindow } from '@main/storage/workspaceFile.js'
import { ConversationLedger, readAgentNameAssignments } from './ledger.js'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const c of cleanups.splice(0)) await c() })

// The persisted shape is the renderer's PersistedWorkspace: `sessions` keyed
// by local id with providerSessionId, kind, cwd, title, agentNameId and the
// orchestration fields (src/renderer/src/workspace/types.ts SessionMeta).
function window(sessions: Record<string, Record<string, unknown>>): PersistedWindow {
  return { windowId: 'w1', bounds: null, displayId: null, fullScreen: false, workspace: { tabs: [], activeTabId: 't', sessions } }
}

describe('conversation ledger', () => {
  it('projects titled, named orchestration children from a workspace save and survives a restart', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ledger-'))
    cleanups.push(() => rm(dir, { recursive: true, force: true }))
    const path = join(dir, 'ledger.jsonl')
    const ledger = await ConversationLedger.open(path)
    await ledger.projectWindows([window({
      parent: { kind: 'claude', cwd: '/repo', providerSessionId: 'p-native', title: 'Picker rebuild', agentNameId: 'id-apollo' },
      child: { kind: 'codex', cwd: '/repo/.worktrees/x', providerSessionId: 'c-native', orchestrationParentId: 'parent', orchestrationRole: 'reviewer', orchestrationRunId: 'run-1' },
      terminal: { kind: 'terminal', cwd: '/repo' },
      pending: { kind: 'claude', cwd: '/repo' },
    })], { 'id-apollo': 'Apollo' }, 1_000)
    expect(ledger.get('claude', 'p-native')).toMatchObject({ localSessionId: 'parent', title: 'Picker rebuild', agentName: 'Apollo', orchestration: null, firstSeenAt: 1_000, closedAt: null })
    expect(ledger.get('codex', 'c-native')).toMatchObject({ orchestration: { parentNativeId: 'p-native', role: 'reviewer', runId: 'run-1' }, cwd: '/repo/.worktrees/x' })
    expect(ledger.rows().size).toBe(2)
    const reopened = await ConversationLedger.open(path)
    expect(reopened.get('codex', 'c-native')?.orchestration?.parentNativeId).toBe('p-native')
  })

  it('writes only what changed, closes rows that vanish, and reopens a closed row that returns', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ledger-'))
    cleanups.push(() => rm(dir, { recursive: true, force: true }))
    const path = join(dir, 'ledger.jsonl')
    const ledger = await ConversationLedger.open(path)
    const sessions = { a: { kind: 'claude', cwd: '/repo', providerSessionId: 'a-native' } }
    await ledger.projectWindows([window(sessions)], {}, 1)
    await ledger.projectWindows([window(sessions)], {}, 2)
    expect((await readFile(path, 'utf8')).trim().split('\n')).toHaveLength(1)
    await ledger.projectWindows([window({})], {}, 3)
    expect(ledger.get('claude', 'a-native')?.closedAt).toBe(3)
    await ledger.projectWindows([window(sessions)], {}, 4)
    expect(ledger.get('claude', 'a-native')).toMatchObject({ closedAt: null, lastSeenAt: 4, firstSeenAt: 1 })
  })

  it('tolerates a truncated last line and compacts a long file on open', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ledger-'))
    cleanups.push(() => rm(dir, { recursive: true, force: true }))
    const path = join(dir, 'ledger.jsonl')
    const ledger = await ConversationLedger.open(path)
    for (let i = 0; i < 50; i++) await ledger.projectWindows([window({ a: { kind: 'claude', cwd: '/repo', providerSessionId: 'a-native', title: `t${i}` } })], {}, i)
    await appendFile(path, '{"provider":"claude","nativeId":"trunc')
    const reopened = await ConversationLedger.open(path)
    expect(reopened.get('claude', 'a-native')?.title).toBe('t49')
    expect((await readFile(path, 'utf8')).trim().split('\n').length).toBeLessThanOrEqual(2)
  })

  it('reads agent name assignments without allocating', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ledger-'))
    cleanups.push(() => rm(dir, { recursive: true, force: true }))
    const names = join(dir, 'agent-names.json')
    await writeFile(names, JSON.stringify({ version: 1, nextIndex: 2, assignments: { 'id-1': 'Apollo', 'id-2': 'Jasper' } }))
    expect(await readAgentNameAssignments(names)).toEqual({ 'id-1': 'Apollo', 'id-2': 'Jasper' })
    expect(await readAgentNameAssignments(join(dir, 'missing.json'))).toEqual({})
  })
})
