import { describe, expect, it, vi } from 'vitest'

import { fromClaudeAgentCodeOrchestrationUse } from '@providers/claude/renderer/adapters/agentCodeOrchestration'
import { fromCodexAgentCodeOrchestrationUse } from '@providers/codex/renderer/adapters/agentCodeOrchestration'
import { fromAgentCodeOrchestrationResult } from '@providers/shared/renderer/protocols/agent-code-orchestration/model'
import type { ToolResultBlock, ToolUseBlock } from '@shared/types/transcript'

const input = {
  kind: 'codex',
  title: 'Phase 7 consultant',
  prompt: 'Review the renderer hierarchy',
  runId: 'phase-7',
}

describe('Agent Code orchestration protocol ownership', () => {
  it('recognizes only the provider-specific spelling of Agent Code tools', () => {
    const claude = {
      type: 'tool_use' as const,
      id: 'claude-create',
      name: 'mcp__agent_code__orchestration_create_agent',
      input,
    }
    const otherServer = { ...claude, name: 'mcp__other_server__orchestration_create_agent' }
    const codex = {
      type: 'tool_use' as const,
      id: 'codex-create',
      name: 'orchestration_create_agent',
      input,
    }

    expect(fromClaudeAgentCodeOrchestrationUse(claude)?.operation).toBe('create-agent')
    expect(fromClaudeAgentCodeOrchestrationUse(otherServer)).toBeNull()
    expect(fromCodexAgentCodeOrchestrationUse(codex)?.operation).toBe('create-agent')
    expect(fromCodexAgentCodeOrchestrationUse(claude)).toBeNull()
  })

  it('parses Claude MCP text content and validates the owned success contract', () => {
    const use = {
      type: 'tool_use' as const,
      id: 'claude-create',
      name: 'mcp__agent_code__orchestration_create_agent',
      input,
    }
    const model = fromClaudeAgentCodeOrchestrationUse(use)!
    const value = {
      ok: true,
      agent: {
        sessionId: 'child-1',
        kind: 'codex',
        cwd: '/workspace',
        lifecycleState: 'running',
      },
      promptSubmitted: true,
    }
    const result: ToolResultBlock = {
      type: 'tool_result',
      tool_use_id: use.id,
      content: [{ type: 'text', text: JSON.stringify(value) }],
    }
    expect(fromAgentCodeOrchestrationResult(result, model)?.value).toEqual(value)

    const drifted: ToolResultBlock = {
      ...result,
      content: [{ type: 'text', text: JSON.stringify({ ok: true, child: value.agent }) }],
    }
    expect(fromAgentCodeOrchestrationResult(drifted, model)).toBeNull()
  })

  it('peels the historical direct Codex wall-time and CallToolResult envelopes', () => {
    const use: ToolUseBlock = {
      type: 'tool_use',
      id: 'codex-list',
      name: 'orchestration_list_agents',
      input: { runId: 'phase-7' },
    }
    const model = fromCodexAgentCodeOrchestrationUse(use)!
    const value = {
      ok: true,
      agents: [{ sessionId: 'child-1', kind: 'claude', cwd: '/workspace' }],
    }
    const callToolResult = {
      content: [{ type: 'text', text: JSON.stringify(value) }],
    }
    const result: ToolResultBlock = {
      type: 'tool_result',
      tool_use_id: use.id,
      content: `Wall time: 0.2 seconds\nOutput:\n${JSON.stringify(callToolResult)}`,
    }
    expect(fromAgentCodeOrchestrationResult(result, model)?.value).toEqual(value)
  })

  it('keeps valid operation failures renderable without inventing one error schema', () => {
    const use: ToolUseBlock = {
      type: 'tool_use',
      id: 'send',
      name: 'orchestration_send_prompt',
      input: { sessionId: 'child-1', prompt: 'Continue' },
    }
    const model = fromCodexAgentCodeOrchestrationUse(use)!
    const value = {
      ok: false,
      error: 'prompt_delivery_failed',
      stage: 'after-enter',
      retrySafe: false,
      promptSubmission: 'uncertain',
    }
    const result: ToolResultBlock = {
      type: 'tool_result',
      tool_use_id: use.id,
      content: JSON.stringify(value),
      is_error: false,
    }
    expect(fromAgentCodeOrchestrationResult(result, model)?.value).toEqual(value)

    const contradictoryTransportFailure: ToolResultBlock = {
      ...result,
      content: JSON.stringify({ ok: true, sessionId: 'child-1' }),
      is_error: true,
    }
    expect(fromAgentCodeOrchestrationResult(contradictoryTransportFailure, model)).toBeNull()
  })

  it('accepts the server-owned large-read recovery range above the generic JSON budget', () => {
    const use: ToolUseBlock = {
      type: 'tool_use',
      id: 'read-large',
      name: 'orchestration_read_agent',
      input: { sessionId: 'child-1', maxCharsPerAgent: 500_000 },
    }
    const model = fromCodexAgentCodeOrchestrationUse(use)!
    const value = {
      ok: true,
      output: {
        agent: { sessionId: 'child-1', kind: 'codex', cwd: '/workspace' },
        messages: [{ role: 'assistant', text: 'x'.repeat(300_000) }],
      },
    }
    const result: ToolResultBlock = {
      type: 'tool_result',
      tool_use_id: use.id,
      content: JSON.stringify(value),
    }

    // WHY this exceeds tryExtractJson's generic 256 KiB limit on purpose: read-agent documents a
    // larger follow-up request as the recovery path after truncation. The owned protocol must not
    // label the server's own valid recovery response "unrecognized".
    expect(fromAgentCodeOrchestrationResult(result, model)?.value).toEqual(value)
  })

  it('parses one immutable result block once across dispatch and owner reads', () => {
    const use: ToolUseBlock = {
      type: 'tool_use',
      id: 'cached-list',
      name: 'orchestration_list_agents',
      input: { runId: 'phase-7' },
    }
    const model = fromCodexAgentCodeOrchestrationUse(use)!
    const result: ToolResultBlock = {
      type: 'tool_result',
      tool_use_id: use.id,
      content: JSON.stringify({ ok: true, agents: [] }),
    }
    const parse = vi.spyOn(JSON, 'parse')
    try {
      expect(fromAgentCodeOrchestrationResult(result, model)).not.toBeNull()
      expect(fromAgentCodeOrchestrationResult(result, model)).not.toBeNull()
      expect(parse).toHaveBeenCalledTimes(1)
    } finally {
      parse.mockRestore()
    }
  })
})
