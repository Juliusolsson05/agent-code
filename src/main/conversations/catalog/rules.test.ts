import { describe, expect, it } from 'vitest'

import type { Conversation } from '@shared/conversations/types.js'
import type { SourceConversation } from '../sources/types.js'
import type { LedgerRow } from '../ledger/types.js'
import { classifyConversation } from './classify.js'
import { activityOf, compareByActivity, decodeCursor, encodeCursor } from './order.js'
import { resolveLabel } from './label.js'
import { unwrapUserText } from './unwrap.js'

// Ingredients copied from corpus rows (ids in comments); only the private
// text is replaced by placeholders, which is what the rules never read.
function source(over: Partial<SourceConversation>): SourceConversation {
  return {
    provider: 'claude', nativeId: 'ededdea8-06bf-4474-b945-b3a8f8ce0fe1', cwd: '/fixture/repo', gitBranch: 'main',
    customTitle: null, aiTitle: null, userTexts: [], createdAt: 1, lastUserActivityAt: null, activitySource: null,
    mtime: 10, promptCount: null, parentNativeId: null, isNativeSubagent: false, isExec: false, originator: null,
    origin: 'scan', available: true, file: null, ...over,
  }
}
const ledger = (over: Partial<LedgerRow>): LedgerRow => ({
  provider: 'claude', nativeId: 'x', localSessionId: null, cwd: null, title: null, agentName: null, orchestration: null,
  firstSeenAt: 1, lastSeenAt: 2, closedAt: null, ...over,
})

describe('classifyConversation', () => {
  it('uses the ledger before the prompt sniff and the sniff for history', () => {
    const child = unwrapUserText('<orchestration-handoff>\nx\n</orchestration-handoff>\n<task>\nreview\n</task>')
    expect(classifyConversation(source({ userTexts: ['<orchestration-handoff>…'] }), null, child)).toBe('orchestration-child')
    expect(classifyConversation(source({}), ledger({ orchestration: { parentNativeId: 'p', role: 'reviewer', runId: null } }), null)).toBe('orchestration-child')
    // The ledger says it was a plain user session even though someone pasted a handoff manually.
    expect(classifyConversation(source({}), ledger({ orchestration: null }), child)).toBe('user')
  })
  it('classifies native subagents, exec runs, projected handoffs and empty transcripts', () => {
    expect(classifyConversation(source({ provider: 'codex', isNativeSubagent: true }), null, { text: 'x', wrapper: null })).toBe('native-subagent')
    expect(classifyConversation(source({ provider: 'codex', isExec: true }), null, { text: 'x', wrapper: null })).toBe('exec')
    expect(classifyConversation(source({}), null, unwrapUserText('# Handoff Summary\n## Objective\nx'))).toBe('projected')
    expect(classifyConversation(source({ provider: 'codex', originator: 'agent-transcript-parser' }), null, { text: 'x', wrapper: null })).toBe('projected')
    // claude a8220281: a 0-byte transcript with nothing to show.
    expect(classifyConversation(source({ available: false, aiTitle: null }), null, null)).toBe('empty')
    expect(classifyConversation(source({ aiTitle: 'p:aa:5' }), null, null)).toBe('user')
  })
})

describe('resolveLabel', () => {
  const first = { text: 'break down this project', wrapper: null } as const
  it('walks the ladder in order and records provenance', () => {
    expect(resolveLabel(source({}), ledger({ title: 'Picker rebuild' }), first, 'repo')).toEqual({ label: 'Picker rebuild', labelSource: 'agent-code-title' })
    expect(resolveLabel(source({ customTitle: 'my title', aiTitle: 'ai' }), null, first, 'repo')).toEqual({ label: 'my title', labelSource: 'provider-name' })
    expect(resolveLabel(source({ aiTitle: 'Project context bootstrapping' }), null, first, 'repo')).toEqual({ label: 'Project context bootstrapping', labelSource: 'ai-title' })
    expect(resolveLabel(source({}), null, first, 'repo')).toEqual({ label: 'break down this project', labelSource: 'first-prompt' })
    expect(resolveLabel(source({}), null, null, 'repo')).toEqual({ label: 'repo', labelSource: 'cwd' })
    expect(resolveLabel(source({ cwd: null }), null, null, null)).toEqual({ label: 'ededdea8', labelSource: 'native-id' })
  })
  it('labels a child by its task and a projected conversation by its heading, and caps the length', () => {
    const child = unwrapUserText('<orchestration-handoff>\nx\n</orchestration-handoff>\n<task>\nReview the Grok lifecycle.\n</task>')
    expect(resolveLabel(source({}), null, child, 'repo')).toEqual({ label: 'Review the Grok lifecycle.', labelSource: 'first-prompt' })
    const long = { text: 'x'.repeat(300), wrapper: null } as const
    expect(resolveLabel(source({}), null, long, 'repo').label).toHaveLength(121)
  })
})

describe('ordering', () => {
  it('prefers user activity over mtime and breaks ties by createdAt then key', () => {
    expect(activityOf(source({ lastUserActivityAt: 500, activitySource: 'history', mtime: 900 }))).toEqual({ at: 500, source: 'history' })
    expect(activityOf(source({ lastUserActivityAt: null, mtime: 900 }))).toEqual({ at: 900, source: 'mtime' })
    const row = (nativeId: string, lastUserActivityAt: number, createdAt: number | null): Conversation => ({
      provider: 'codex', nativeId, cwd: '/fixture/repo', repoRoot: '/fixture/repo', worktree: null, gitBranch: null, kind: 'user',
      parentNativeId: null, label: nativeId, labelSource: 'native-id', firstPrompt: null, agentName: null, agentCodeTitle: null,
      createdAt, lastUserActivityAt, activitySource: 'index', promptCount: null, available: true, origin: 'index', match: null,
    })
    const sorted = [row('a', 1, 1), row('b', 5, 1), row('c', 5, 9), row('d', 5, 9)].sort(compareByActivity)
    expect(sorted.map(r => r.nativeId)).toEqual(['c', 'd', 'b', 'a'])
    const cursor = encodeCursor(sorted[1]!)
    expect(decodeCursor(cursor)).toEqual({ at: 5, key: 'codex:d' })
    expect(decodeCursor('garbage')).toBeNull()
  })
})
