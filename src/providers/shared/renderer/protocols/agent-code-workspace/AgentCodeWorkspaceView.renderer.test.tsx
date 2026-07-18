import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import {
  ProviderContext,
  ToolResultIndexContext,
  ToolUseIndexContext,
} from '@renderer/features/feed/context'
import { Block } from '@renderer/features/feed/ui/rows/Block'
import type { ToolResultBlock, ToolUseBlock } from '@shared/types/transcript'
import { AgentCodeWorkspaceView } from './AgentCodeWorkspaceView'

const workspaceResultParse = vi.hoisted(() => vi.fn())

vi.mock('./model', async importOriginal => {
  const actual = await importOriginal<typeof import('./model')>()
  return {
    ...actual,
    fromAgentCodeWorkspaceResult: (...args: Parameters<typeof actual.fromAgentCodeWorkspaceResult>) => {
      workspaceResultParse()
      return actual.fromAgentCodeWorkspaceResult(...args)
    },
  }
})

vi.mock('@renderer/lib/code/CodeBlock', () => ({
  CodeBlock: ({ code }: { code: string }) => <pre data-testid="code-block">{code}</pre>,
}))

const use: ToolUseBlock = {
  type: 'tool_use',
  id: 'attach-file',
  name: 'ai_workspace_attach_file',
  input: {
    workspaceId: 'workspace-1',
    path: '/repo/docs/rendering.md',
    title: 'Rendering plan',
  },
}
const result: ToolResultBlock = {
  type: 'tool_result',
  tool_use_id: use.id,
  content: JSON.stringify({
    ok: true,
    entry: { title: 'Rendering plan', path: '/repo/docs/rendering.md' },
  }),
}

describe('AgentCodeWorkspaceView', () => {
  it('renders the owned hierarchy and absorbs a validated paired result', () => {
    render(
      <ProviderContext.Provider value="codex">
        <ToolUseIndexContext.Provider value={new Map([[use.id, use]])}>
          <ToolResultIndexContext.Provider value={new Map([[use.id, result]])}>
            <Block block={use} role="assistant" />
            <Block block={result} role="user" />
          </ToolResultIndexContext.Provider>
        </ToolUseIndexContext.Provider>
      </ProviderContext.Provider>,
    )

    expect(screen.getByText('Agent Code MCP')).toBeInTheDocument()
    expect(screen.getByText('AI Workspace')).toBeInTheDocument()
    expect(screen.getByText('Attach file')).toBeInTheDocument()
    expect(screen.getByText('Rendering plan')).toBeInTheDocument()
    expect(screen.getByText('done')).toBeInTheDocument()
    expect(screen.queryByText('ok: true')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button'))
    expect(screen.getByText('Protocol input')).toBeInTheDocument()
    expect(screen.getByText('Protocol result')).toBeInTheDocument()
  })

  it('does not claim another Claude MCP namespace', () => {
    const external: ToolUseBlock = {
      ...use,
      id: 'external',
      name: 'mcp__external__ai_workspace_attach_file',
    }
    render(
      <ProviderContext.Provider value="claude">
        <Block block={external} role="assistant" />
      </ProviderContext.Provider>,
    )
    expect(screen.getByText('MCP · external')).toBeInTheDocument()
    expect(screen.queryByText('Agent Code MCP')).not.toBeInTheDocument()
  })

  it('keeps validated large-result work memoized across unrelated index appends', () => {
    workspaceResultParse.mockClear()
    const model = {
      operationId: use.id,
      tool: 'ai_workspace_attach_file' as const,
      action: 'Attach file',
      subject: 'Rendering plan',
      workspaceId: 'workspace-1',
      path: '/repo/docs/rendering.md',
      input: use.input as Record<string, unknown>,
    }
    const unrelated: ToolResultBlock = {
      type: 'tool_result',
      tool_use_id: 'unrelated-workspace',
      content: 'unrelated',
    }
    const { rerender } = render(
      <ToolResultIndexContext.Provider value={new Map([[use.id, result]])}>
        <AgentCodeWorkspaceView model={model} />
      </ToolResultIndexContext.Provider>,
    )
    expect(workspaceResultParse).toHaveBeenCalledTimes(1)

    rerender(
      <ToolResultIndexContext.Provider value={new Map([
        [use.id, result],
        [unrelated.tool_use_id, unrelated],
      ])}>
        <AgentCodeWorkspaceView model={{ ...model, input: { ...model.input } }} />
      </ToolResultIndexContext.Provider>,
    )
    expect(workspaceResultParse).toHaveBeenCalledTimes(1)
  })
})
