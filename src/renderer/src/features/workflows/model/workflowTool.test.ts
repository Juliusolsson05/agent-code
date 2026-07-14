import { describe, expect, it } from 'vitest'

import {
  isWorkflowRunToolName,
  parseWorkflowRunReference,
  parseWorkflowToolResult,
} from './workflowTool'

describe('workflow tool recognition', () => {
  it('recognizes bare, Claude MCP, and alternate namespace spellings only', () => {
    expect(isWorkflowRunToolName('workflow_run')).toBe(true)
    expect(isWorkflowRunToolName('mcp__agent_code__workflow_run')).toBe(true)
    expect(isWorkflowRunToolName('agent-code/workflow_run')).toBe(true)
    expect(isWorkflowRunToolName('workflow_run_status')).toBe(false)
    expect(isWorkflowRunToolName('some_workflow_runner')).toBe(false)
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
