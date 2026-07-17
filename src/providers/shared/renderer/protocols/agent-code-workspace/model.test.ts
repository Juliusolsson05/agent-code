import { describe, expect, it } from 'vitest'

import { fromCodexAgentCodeWorkspaceUse } from '@providers/codex/renderer/adapters/agentCodeWorkspace'
import { fromClaudeAgentCodeWorkspaceUse } from '@providers/claude/renderer/adapters/agentCodeWorkspace'
import type { ToolResultBlock, ToolUseBlock } from '@shared/types/transcript'

import { fromAgentCodeWorkspaceResult } from './model'

describe('Agent Code workspace protocol', () => {
  it('accepts the observed Codex bare name with the owned schema', () => {
    const block: ToolUseBlock = {
      type: 'tool_use',
      id: 'attach',
      name: 'ai_workspace_attach_file',
      input: {
        workspaceId: 'ws-1',
        path: '/repo/docs/plan.md',
        title: 'Plan',
      },
    }
    expect(fromCodexAgentCodeWorkspaceUse(block)).toMatchObject({
      tool: 'ai_workspace_attach_file',
      action: 'Attach file',
      subject: 'Plan',
      workspaceId: 'ws-1',
      path: '/repo/docs/plan.md',
    })
  })

  it('requires Claude Agent Code namespace and complete required fields', () => {
    const base: ToolUseBlock = {
      type: 'tool_use',
      id: 'create',
      name: 'mcp__agent_code__ai_workspace_create',
      input: { name: 'Review plans' },
    }
    expect(fromClaudeAgentCodeWorkspaceUse(base)?.subject).toBe('Review plans')
    expect(fromClaudeAgentCodeWorkspaceUse({
      ...base,
      name: 'mcp__another_server__ai_workspace_create',
    })).toBeNull()
    expect(fromClaudeAgentCodeWorkspaceUse({ ...base, input: {} })).toBeNull()
  })

  it('absorbs only the explicit source-controlled ok result contract', () => {
    const source = fromCodexAgentCodeWorkspaceUse({
      type: 'tool_use',
      id: 'list',
      name: 'ai_workspace_list_files',
      input: { workspaceId: 'ws-1' },
    })!
    const result: ToolResultBlock = {
      type: 'tool_result',
      tool_use_id: 'list',
      content: '{"ok":true,"workspace":{"name":"Plans","entries":[{},{}]}}',
    }
    expect(fromAgentCodeWorkspaceResult(result, source)).toMatchObject({
      ok: true,
      summary: 'Plans',
    })
    expect(fromAgentCodeWorkspaceResult({ ...result, content: '{"workspace":{}}' }, source)).toBeNull()
  })

  it('preserves the captured Codex transport envelope around workspace results', () => {
    const source = fromCodexAgentCodeWorkspaceUse({
      type: 'tool_use',
      id: 'open',
      name: 'ai_workspace_open',
      input: { workspaceId: 'ws-1' },
    })!
    const ownedResult = JSON.stringify([{
      type: 'text',
      text: JSON.stringify({
        ok: true,
        workspace: { workspaceId: 'ws-1', name: 'Review plans' },
      }),
    }])
    const result: ToolResultBlock = {
      type: 'tool_result',
      tool_use_id: 'open',
      content: `Wall time: 0.0095 seconds\nOutput:\n${ownedResult}`,
    }

    // WHY pin the wrapper, not just the inner JSON: historical Codex sessions
    // use this exact human transport envelope. Workspace ownership depends on
    // the shared extractor peeling it before validating the Agent Code schema;
    // a future "cleanup" of that peel must not silently break every replay.
    expect(fromAgentCodeWorkspaceResult(result, source)).toMatchObject({
      ok: true,
      summary: 'Review plans',
    })
  })
})
