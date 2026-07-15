import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import type { ToolResultBlock, ToolUseBlock } from '@shared/types/transcript'
import {
  CodeRenderContext,
  ToolResultIndexContext,
  ToolUseIndexContext,
} from '@renderer/features/feed/context'
import { Block } from '@renderer/features/feed/ui/rows/Block'
import { SemanticLiveBlockRow } from '@renderer/features/feed/ui/semantic/BlockRow'

const launch = {
  ok: true,
  run: {
    runId: 'run-feed',
    cwd: '/repo',
    status: 'running',
    cursor: 1,
    workflow: { name: 'fat-bug-hunt', title: 'Deep hunt' },
  },
}

describe('workflow feed ownership', () => {
  it('keeps the committed launch as a transcript tool row without mounting the inspector', () => {
    const toolUse: ToolUseBlock = {
      type: 'tool_use',
      id: 'workflow-tool',
      name: 'mcp__agent_code__workflow_run',
      input: { workflow: 'fat-bug-hunt' },
    }
    const toolResult: ToolResultBlock = {
      type: 'tool_result',
      tool_use_id: toolUse.id,
      content: JSON.stringify(launch),
    }
    const { container } = render(
      <CodeRenderContext.Provider value={{ sessionId: 'session', workspaceRoot: '/repo' }}>
        <ToolUseIndexContext.Provider value={new Map([[toolUse.id, toolUse]])}>
          <ToolResultIndexContext.Provider value={new Map([[toolUse.id, toolResult]])}>
            <Block block={toolUse} role="assistant" />
            <Block block={toolResult} role="user" />
          </ToolResultIndexContext.Provider>
        </ToolUseIndexContext.Provider>
      </CodeRenderContext.Provider>,
    )

    expect(container.querySelectorAll('[data-workflow-run-id="run-feed"]')).toHaveLength(0)
    expect(container.textContent).not.toContain('"runId":"run-feed"')
  })

  it('keeps live Claude/Codex MCP blocks out of the workflow inspector viewport', () => {
    render(
      <CodeRenderContext.Provider value={{ sessionId: 'session', workspaceRoot: '/repo' }}>
        <SemanticLiveBlockRow
          block={{
            blockIndex: 0,
            kind: 'mcp_tool_use',
            toolName: 'mcp__agent_code__workflow_run',
            toolUseId: 'live-workflow',
            resultContent: JSON.stringify(launch),
            resultAt: Date.now(),
          }}
          toolState={{
            toolUseId: 'live-workflow',
            blockIndex: 0,
            kind: 'mcp_tool_use',
            toolName: 'mcp__agent_code__workflow_run',
            status: 'completed',
            inputJson: '{}',
            resultContent: JSON.stringify(launch),
          }}
        />
      </CodeRenderContext.Provider>,
    )

    expect(document.querySelectorAll('[data-workflow-run-id="run-feed"]')).toHaveLength(0)
  })
})
