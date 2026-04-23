#!/usr/bin/env tsx
import assert from 'node:assert/strict'

import type { SemanticRuntimeState } from '../src/renderer/src/workspace/workspaceState.ts'

function baseState(): SemanticRuntimeState {
  const state: SemanticRuntimeState = {
    currentTurn: null,
    history: [],
    flows: {},
    errors: [],
    log: [],
    nextLogId: 1,
  }
  state.currentTurn = {
    turnId: 'msg_aaa',
    text: 'partial',
    source: 'proxy',
    blocks: {
      0: {
        blockIndex: 0,
        kind: 'tool_use',
        toolName: 'Bash',
        toolUseId: 'toolu_xyz',
        text: '',
        thinking: '',
        inputJson: '{}',
      },
    },
    blockOrder: [0],
    stopReason: 'tool_use',
    usage: null,
    task: {
      todos: [],
      doneCount: 0,
      totalCount: 0,
      inProgressToolUseIds: ['toolu_xyz'],
      activeToolNames: ['Bash'],
    },
    lookups: {
      toolCallsById: {
        toolu_xyz: {
          toolUseId: 'toolu_xyz',
          blockIndex: 0,
          kind: 'tool_use',
          toolName: 'Bash',
          status: 'in_progress',
          inputJson: '{}',
          resultContent: null,
        },
      },
      toolUseIdsInOrder: ['toolu_xyz'],
      resolvedToolUseIds: [],
      erroredToolUseIds: [],
    },
    startedAt: 1,
    endedAt: 2,
  }
  return state
}

async function main(): Promise<void> {
  const documentElement = {
    dataset: {} as Record<string, string>,
    style: { setProperty() {} },
  }
  Object.assign(globalThis, {
    document: { documentElement },
    CustomEvent: class CustomEvent<T = unknown> {
      constructor(
        public type: string,
        public init?: { detail?: T },
      ) {}
    },
    localStorage: {
      getItem() { return null },
      setItem() {},
      removeItem() {},
    },
    window: {
      dispatchEvent() { return true },
      addEventListener() {},
      removeEventListener() {},
      api: {},
    },
  })
  const { foldSemanticEvent } = await import('../src/renderer/src/workspace/workspaceStore.ts')

  const next = foldSemanticEvent(
    baseState(),
    {
      type: 'tool_result',
      toolUseId: 'toolu_xyz',
      content: 'ok',
      isError: false,
      source: 'jsonl',
      confidence: 'high',
      ts: Date.now(),
    },
    'claude',
  )

  assert.equal(next.currentTurn, null)
  assert.equal(next.history.length, 1)
  const archived = next.history[0]
  assert.equal(archived.turnId, 'msg_aaa')
  assert.match(archived.text, /partial/)

  console.log('ok - claude tool_result without turnId still resolves by toolUseId')
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
