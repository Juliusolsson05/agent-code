import { renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { emptyRuntime, emptySemanticRuntime } from '@renderer/session-runtime/state'
import type { SemanticLiveTurn } from '@renderer/session-runtime/state'
import type { ProviderConditionSnapshot } from '@shared/types/providerConditions'

import { useAgentFeedModel, type AgentFeedRuntime } from './useAgentFeedModel'

// The runtime → paint mapping both the desktop pane and the phone now call
// (#1177). The phone used to hand-mirror it, and the mirror drew the RAW
// condition snapshot: with Claude compaction running and no screen snapshot
// (a no-screen moment, or the phone before its first conditions frame), the
// desktop showed the compaction state from structured evidence and the phone
// showed nothing. These cases pin what every surface now gets.

function runtime(overrides: Partial<AgentFeedRuntime> = {}): AgentFeedRuntime {
  const base = emptyRuntime()
  return {
    entries: base.entries,
    semantic: emptySemanticRuntime(),
    ghosts: new Map(),
    streamPhase: 'idle',
    streamPhasePendingToolName: null,
    streamPhasePendingToolUseId: null,
    turnStartedAt: null,
    lastJsonlEntryAt: null,
    toolUseIndex: base.toolUseIndex,
    toolResultIndex: base.toolResultIndex,
    toolIndexVersion: 0,
    conditions: null,
    subAgents: null,
    hasOlderHistory: false,
    loadingOlderHistory: false,
    bootstrapping: false,
    ...overrides,
  }
}

const compactionTurn = {
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
} as unknown as SemanticLiveTurn

describe('useAgentFeedModel', () => {
  it('draws the provider-normalized condition even before any screen snapshot', () => {
    const { result } = renderHook(() =>
      useAgentFeedModel(
        runtime({ semantic: { ...emptySemanticRuntime(), currentTurn: compactionTurn } }),
        'claude',
        'session-1',
      ),
    )
    const compaction = result.current.normalizedConditions?.provider === 'claude'
      ? result.current.normalizedConditions.conditions['claude.compaction']?.state
      : undefined
    expect(compaction).toMatchObject({ visible: true, phase: 'running' })
  })

  it('tells "no snapshot yet" apart from "a snapshot without the question"', () => {
    // Feed gates clickability on this: undefined keeps an inline question
    // row waiting for its snapshot, null says the picker is gone.
    const none = renderHook(() => useAgentFeedModel(runtime(), 'claude', 'session-1'))
    expect(none.result.current.askUserQuestionState).toBeUndefined()

    const without: ProviderConditionSnapshot = { provider: 'claude', ts: 1, conditions: {} }
    const some = renderHook(() => useAgentFeedModel(runtime({ conditions: without }), 'claude', 'session-1'))
    expect(some.result.current.askUserQuestionState).toBeNull()
  })
})
