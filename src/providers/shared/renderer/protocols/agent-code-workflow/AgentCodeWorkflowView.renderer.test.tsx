import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import {
  ProviderContext,
  ToolResultIndexContext,
  ToolUseIndexContext,
} from '@renderer/features/feed/context'
import { Block } from '@renderer/features/feed/ui/rows/Block'
import type { ToolResultBlock, ToolUseBlock } from '@shared/types/transcript'

vi.mock('@renderer/lib/code/CodeBlock', () => ({
  CodeBlock: ({ code }: { code: string }) => <pre data-testid="code-block">{code}</pre>,
}))

describe('AgentCodeWorkflowView', () => {
  it('renders owned hierarchy and absorbs a launch envelope already owned by the session view', () => {
    const use: ToolUseBlock = {
      type: 'tool_use', id: 'run', name: 'mcp__agent_code__workflow_run', input: { name: 'audit' },
    }
    const result: ToolResultBlock = {
      type: 'tool_result', tool_use_id: use.id, content: JSON.stringify({
        ok: true,
        run: { runId: 'run-1', status: 'running', workflow: { name: 'audit', title: 'Deep audit' } },
      }),
    }
    render(
      <ProviderContext.Provider value="claude">
        <ToolUseIndexContext.Provider value={new Map([[use.id, use]])}>
          <ToolResultIndexContext.Provider value={new Map([[use.id, result]])}>
            <Block block={use} role="assistant" />
            <Block block={result} role="user" />
          </ToolResultIndexContext.Provider>
        </ToolUseIndexContext.Provider>
      </ProviderContext.Provider>,
    )

    expect(screen.getByText('Agent Code MCP')).toBeInTheDocument()
    expect(screen.getByText('Workflow')).toBeInTheDocument()
    expect(screen.getByText('Deep audit')).toBeInTheDocument()
    expect(screen.getByText('running')).toBeInTheDocument()
    expect(screen.queryByText(/"runId"/)).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button'))
    expect(screen.getByText('run-1')).toBeInTheDocument()
  })
})
