import { describe, expect, it } from 'vitest'

import { fromClaudeAgentCodeWorkflowUse } from '@providers/claude/renderer/adapters/agentCodeWorkflow'
import { fromCodexAgentCodeWorkflowUse } from '@providers/codex/renderer/adapters/agentCodeWorkflow'
import type { ToolResultBlock, ToolUseBlock } from '@shared/types/transcript'

import { fromAgentCodeWorkflowResult } from './model'

describe('Agent Code workflow protocol', () => {
  it('admits only exact owned provider names and source selectors', () => {
    const claude: ToolUseBlock = {
      type: 'tool_use', id: 'run', name: 'mcp__agent_code__workflow_run', input: { name: 'audit' },
    }
    expect(fromClaudeAgentCodeWorkflowUse(claude)?.subject).toBe('audit')
    expect(fromClaudeAgentCodeWorkflowUse({
      ...claude, name: 'mcp__external__workflow_run',
    })).toBeNull()
    expect(fromCodexAgentCodeWorkflowUse({
      ...claude, name: 'workflow_run', input: {},
    })).toBeNull()
  })

  it('recognizes a proven run reference in the paired launch envelope', () => {
    const model = fromCodexAgentCodeWorkflowUse({
      type: 'tool_use', id: 'run', name: 'workflow_run', input: { scriptPath: '/repo/.claude/workflows/audit.js' },
    })!
    const result: ToolResultBlock = {
      type: 'tool_result', tool_use_id: 'run', content: JSON.stringify({
        ok: true,
        run: { runId: 'run-1', status: 'running', workflow: { name: 'audit' } },
      }),
    }
    expect(fromAgentCodeWorkflowResult(result, model)).toMatchObject({
      runId: 'run-1', status: 'running',
    })
  })
})
