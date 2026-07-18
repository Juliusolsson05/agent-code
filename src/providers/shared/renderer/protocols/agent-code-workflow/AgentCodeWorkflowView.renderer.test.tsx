import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import {
  ProviderContext,
  ToolResultIndexContext,
  ToolUseIndexContext,
} from '@renderer/features/feed/context'
import { Block } from '@renderer/features/feed/ui/rows/Block'
import type { ToolResultBlock, ToolUseBlock } from '@shared/types/transcript'
import { AgentCodeWorkflowView } from './AgentCodeWorkflowView'

const workflowResultParse = vi.hoisted(() => vi.fn())

vi.mock('./model', async importOriginal => {
  const actual = await importOriginal<typeof import('./model')>()
  return {
    ...actual,
    fromAgentCodeWorkflowResult: (...args: Parameters<typeof actual.fromAgentCodeWorkflowResult>) => {
      workflowResultParse()
      return actual.fromAgentCodeWorkflowResult(...args)
    },
  }
})

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

  it('does not reparse a large result when an unrelated pair enters the index', () => {
    workflowResultParse.mockClear()
    const model = {
      operationId: 'memo-workflow',
      tool: 'workflow_run' as const,
      action: 'Run workflow' as const,
      subject: 'audit',
      input: { name: 'audit' },
    }
    const result: ToolResultBlock = {
      type: 'tool_result',
      tool_use_id: model.operationId,
      content: JSON.stringify({
        ok: true,
        run: { runId: 'memo-run', status: 'running', workflow: { name: 'audit' } },
      }),
    }
    const unrelated: ToolResultBlock = {
      type: 'tool_result',
      tool_use_id: 'someone-else',
      content: 'unrelated',
    }
    const { rerender } = render(
      <ToolResultIndexContext.Provider value={new Map([[model.operationId, result]])}>
        <AgentCodeWorkflowView model={model} />
      </ToolResultIndexContext.Provider>,
    )
    expect(workflowResultParse).toHaveBeenCalledTimes(1)

    rerender(
      <ToolResultIndexContext.Provider value={new Map([
        [model.operationId, result],
        [unrelated.tool_use_id, unrelated],
      ])}>
        {/* WHY the copied model matters: provider dispatch is allowed to
            normalize again during reconciliation. That allocation alone must
            not invalidate a parse whose semantic pair is unchanged. */}
        <AgentCodeWorkflowView model={{ ...model, input: { ...model.input } }} />
      </ToolResultIndexContext.Provider>,
    )
    expect(workflowResultParse).toHaveBeenCalledTimes(1)

    const arrivedReplacement: ToolResultBlock = {
      ...result,
      content: JSON.stringify({
        ok: true,
        run: { runId: 'memo-run-2', status: 'completed', workflow: { name: 'audit' } },
      }),
    }
    rerender(
      <ToolResultIndexContext.Provider value={new Map([
        [model.operationId, arrivedReplacement],
        [unrelated.tool_use_id, unrelated],
      ])}>
        <AgentCodeWorkflowView model={{ ...model, input: { ...model.input } }} />
      </ToolResultIndexContext.Provider>,
    )
    // A changed exact result is real pair evidence, unlike the unrelated map
    // append above, and therefore must invalidate the expensive parse once.
    expect(workflowResultParse).toHaveBeenCalledTimes(2)
    expect(screen.getByText('completed')).toBeInTheDocument()
  })
})
