import { describe, expect, it } from 'vitest'

import {
  collectWorkflowRunReferences,
  isWorkflowRunToolName,
  isWorkflowViewToolName,
  parseWorkflowRunReference,
  parseWorkflowToolResult,
} from './workflowTool'

describe('workflow tool recognition', () => {
  it('recognizes only Agent Code owned bare and Claude MCP spellings', () => {
    expect(isWorkflowRunToolName('workflow_run')).toBe(true)
    expect(isWorkflowRunToolName('mcp__agent_code__workflow_run')).toBe(true)
    expect(isWorkflowRunToolName('agent-code/workflow_run')).toBe(true)
    expect(isWorkflowRunToolName('agent-code:workflow_run')).toBe(true)
    expect(isWorkflowRunToolName('mcp__external__workflow_run')).toBe(false)
    expect(isWorkflowRunToolName('workflow_run_status')).toBe(false)
    expect(isWorkflowRunToolName('some_workflow_runner')).toBe(false)
    expect(isWorkflowViewToolName('mcp__agent_code__workflow_resume')).toBe(true)
  })
})

describe('parseWorkflowRunReference', () => {
  const expected = {
    runId: 'run-42',
    status: 'running',
    cursor: 1,
    workflow: {
      name: 'fat-bug-hunt',
      title: 'Deep bug hunt',
      description: 'Find, deduplicate, and verify bugs',
    },
  }

  it('reads direct structured content', () => {
    expect(parseWorkflowRunReference({ ok: true, run: expected })).toEqual(expected)
  })

  it('reads Claude MCP text content', () => {
    expect(parseWorkflowToolResult({
      type: 'tool_result',
      tool_use_id: 'tool-1',
      content: [{ type: 'text', text: JSON.stringify({ structuredContent: { run: expected } }) }],
    })).toEqual(expected)
  })

  it('recovers a JSON payload from a Codex diagnostic wrapper', () => {
    const wrapped = [
      'Tool completed in 18ms',
      JSON.stringify({ content: [{ type: 'text', text: JSON.stringify({ run: expected }) }] }),
      'Wall time: 0.02 seconds',
    ].join('\n')
    expect(parseWorkflowRunReference(wrapped)).toEqual(expected)
  })

  it('does not manufacture a run from malformed or unrelated content', () => {
    expect(parseWorkflowRunReference('{"runId":')).toBeNull()
    expect(parseWorkflowRunReference({ run: { id: 'not-the-contract' } })).toBeNull()
    expect(parseWorkflowRunReference('workflow run-42 started')).toBeNull()
  })
})

describe('collectWorkflowRunReferences', () => {
  it('deduplicates live and committed launch envelopes without depending on feed rendering', () => {
    const run = {
      runId: 'run-view',
      cwd: '/repo',
      status: 'running',
      workflow: { name: 'fat-bug-hunt', title: 'Deep hunt' },
    }
    const toolUse = {
      type: 'tool_use' as const,
      id: 'workflow-tool',
      name: 'mcp__agent_code__workflow_run',
      input: { name: 'fat-bug-hunt' },
    }
    const toolResult = {
      type: 'tool_result' as const,
      tool_use_id: toolUse.id,
      content: JSON.stringify({ ok: true, run }),
    }
    const references = collectWorkflowRunReferences({
      toolUseIndex: new Map([[toolUse.id, toolUse]]),
      toolResultIndex: new Map([[toolUse.id, toolResult]]),
      semanticTurns: [{
        turnId: 'turn-1',
        text: '',
        source: 'codex',
        blocks: {
          0: {
            blockIndex: 0,
            kind: 'function_call',
            toolName: 'mcp__agent_code__workflow_run',
            callId: toolUse.id,
            output: { structuredContent: { run } },
          },
        },
        blockOrder: [0],
        stopReason: null,
        usage: null,
        task: {
          todos: [],
          doneCount: 0,
          totalCount: 0,
          inProgressToolUseIds: [],
          activeToolNames: [],
        },
        lookups: {
          toolCallsById: {},
          toolUseIdsInOrder: [],
          resolvedToolUseIds: [],
          erroredToolUseIds: [],
        },
        startedAt: 1,
        endedAt: 2,
      }],
    })

    expect(references).toEqual([run])
  })
})
