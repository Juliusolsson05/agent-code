import { describe, expect, it } from 'vitest'

import { normalizeClaudeCompactionConditions } from './model'
import type { SemanticLiveTurn } from '@renderer/session-runtime/state'
import type { Entry } from '@shared/types/transcript'
import type { ProviderConditionSnapshot } from '@shared/types/providerConditions'

function turn(overrides: Partial<SemanticLiveTurn> = {}): SemanticLiveTurn {
  return {
    turnId: 'compact-1',
    text: '',
    source: 'claude-proxy',
    blocks: {},
    blockOrder: [],
    stopReason: null,
    usage: null,
    task: { todos: [], doneCount: 0, totalCount: 0, inProgressToolUseIds: [], activeToolNames: [] },
    lookups: { toolCallsById: {}, toolUseIdsInOrder: [], resolvedToolUseIds: [], erroredToolUseIds: [] },
    startedAt: 1_000,
    endedAt: null,
    isCompactionSynthesis: true,
    ...overrides,
  }
}

function screen(phase: 'running' | 'error' | 'done'): ProviderConditionSnapshot {
  return {
    provider: 'claude',
    ts: 2_000,
    conditions: {
      'claude.compaction': {
        kind: 'claude.compaction',
        state: { visible: true, phase, errorText: phase === 'error' ? 'screen failure' : undefined },
        actions: [],
      },
    },
  }
}

function state(snapshot: ProviderConditionSnapshot | null) {
  return snapshot?.provider === 'claude'
    ? snapshot.conditions['claude.compaction']?.state
    : undefined
}

describe('Claude compaction condition normalization', () => {
  it('starts from structured evidence with the screen channel absent', () => {
    const result = normalizeClaudeCompactionConditions({ snapshot: null, currentTurn: turn(), entries: [] })
    expect(state(result)).toMatchObject({
      visible: true,
      phase: 'running',
      source: 'structured',
      operationId: 'compact-1',
    })
  })

  it('retains a screen-only fallback when structured evidence is unavailable', () => {
    const result = normalizeClaudeCompactionConditions({ snapshot: screen('running'), currentTurn: null, entries: [] })
    expect(state(result)).toMatchObject({ phase: 'running', source: 'screen' })
  })

  it('does not let a stale screen done state suppress a structured running operation', () => {
    const result = normalizeClaudeCompactionConditions({ snapshot: screen('done'), currentTurn: turn(), entries: [] })
    expect(state(result)).toMatchObject({ phase: 'running', source: 'structured' })
  })

  it('uses the screen parser only for the structured lifecycle fact it cannot prove: errors', () => {
    const result = normalizeClaudeCompactionConditions({ snapshot: screen('error'), currentTurn: turn(), entries: [] })
    expect(state(result)).toMatchObject({ phase: 'error', source: 'screen', errorText: 'screen failure' })
  })

  it('finishes from the durable summary without consulting screen state', () => {
    const summary: Entry = {
      type: 'user',
      uuid: 'summary',
      timestamp: new Date(1_500).toISOString(),
      isCompactSummary: true,
      message: { role: 'user', content: [{ type: 'text', text: 'summary' }] },
    }
    const result = normalizeClaudeCompactionConditions({ snapshot: screen('running'), currentTurn: turn({ endedAt: 1_400 }), entries: [summary] })
    expect(state(result)).toMatchObject({ phase: 'done', source: 'structured' })
  })

  it('does not let a stale screen error regress a durable completion', () => {
    const summary: Entry = {
      type: 'user',
      timestamp: new Date(1_500).toISOString(),
      isCompactSummary: true,
      message: { role: 'user', content: [{ type: 'text', text: 'summary' }] },
    }
    const result = normalizeClaudeCompactionConditions({
      snapshot: screen('error'),
      currentTurn: turn({ endedAt: 1_400 }),
      entries: [summary],
    })
    expect(state(result)).toMatchObject({ phase: 'done', source: 'structured' })
  })

  it('does not let an uncorrelated summary without time complete a new operation', () => {
    const summary: Entry = {
      type: 'user',
      isCompactSummary: true,
      message: { role: 'user', content: [{ type: 'text', text: 'old summary' }] },
    }
    const result = normalizeClaudeCompactionConditions({
      snapshot: screen('running'),
      currentTurn: turn(),
      entries: [summary],
    })
    expect(state(result)).toMatchObject({ phase: 'running', source: 'structured' })
  })

  it('lets a recent durable summary close a stale screen operation after turn handoff', () => {
    const summary: Entry = {
      type: 'user',
      timestamp: new Date(1_500).toISOString(),
      isCompactSummary: true,
      message: { role: 'user', content: [{ type: 'text', text: 'summary' }] },
    }
    const result = normalizeClaudeCompactionConditions({
      snapshot: screen('running'),
      currentTurn: null,
      entries: [summary],
    })
    expect(state(result)).toMatchObject({ phase: 'done', source: 'structured' })
  })

  it('does not regress durable completion when later screen ticks still say running', () => {
    const summary: Entry = {
      type: 'user',
      timestamp: new Date(1_500).toISOString(),
      isCompactSummary: true,
      message: { role: 'user', content: [{ type: 'text', text: 'summary' }] },
    }
    const lateScreen = { ...screen('running'), ts: 120_000 }
    const result = normalizeClaudeCompactionConditions({
      snapshot: lateScreen,
      currentTurn: null,
      entries: [summary],
    })
    expect(state(result)).toMatchObject({ phase: 'done', source: 'structured' })
  })
})
