import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import agentFixture from '../../../../testing/fixtures/rendering-shapes/claude/agent/final.json'
import { fromClaudeAgentUse } from '@providers/claude/renderer/adapters/collaboration'
import { ClaudeAgentRow } from '@providers/claude/renderer/components/agent'
import {
  renderClaudeToolResult,
  renderClaudeToolUse,
} from '@providers/claude/renderer/rows/dispatch'
import {
  ProviderContext,
  SubAgentsContext,
  TaskNotificationsContext,
  ToolResultIndexContext,
  ToolUseIndexContext,
} from '@renderer/features/feed/context'
import { Block } from '@renderer/features/feed/ui/rows/Block'
import type { SubAgentState } from '@renderer/session-runtime/state'
import type { TaskNotification } from '@renderer/session-runtime/taskNotification'
import type { ToolResultBlock, ToolUseBlock } from '@shared/types/transcript'

vi.mock('@providers/shared/renderer/components/lazy-prose', () => ({
  LazyTextProse: ({ text }: { text: string }) => <div data-testid="text-prose">{text}</div>,
}))

const agentUse = agentFixture.toolUse as ToolUseBlock
const agentResult = agentFixture.toolResult as unknown as ToolResultBlock

function contexts(
  node: React.ReactNode,
  options: {
    result?: ToolResultBlock
    subagent?: SubAgentState
    notification?: TaskNotification
    provider?: 'claude' | 'codex'
  } = {},
) {
  const resultMap = options.result ? new Map([[agentUse.id, options.result]]) : new Map()
  const useMap = new Map([[agentUse.id, agentUse]])
  const notifications = options.notification
    ? new Map([[agentUse.id, options.notification]])
    : new Map()
  return (
    <ProviderContext.Provider value={options.provider ?? 'claude'}>
      <ToolUseIndexContext.Provider value={useMap}>
        <ToolResultIndexContext.Provider value={resultMap}>
          <SubAgentsContext.Provider
            value={options.subagent ? { [agentUse.id]: options.subagent } : {}}
          >
            <TaskNotificationsContext.Provider value={notifications}>
              {node}
            </TaskNotificationsContext.Provider>
          </SubAgentsContext.Provider>
        </ToolResultIndexContext.Provider>
      </ToolUseIndexContext.Provider>
    </ProviderContext.Provider>
  )
}

describe('Claude provider-owned Agent collaboration card', () => {
  it('absorbs the paired result into one lazy durable card', () => {
    render(
      contexts(<ClaudeAgentRow model={fromClaudeAgentUse(agentUse)!} />, { result: agentResult }),
    )
    const button = screen.getByRole('button', { name: /Explore.*Inspect renderer ownership.*done/ })
    expect(button).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByTestId('text-prose')).not.toBeInTheDocument()

    fireEvent.click(button)
    expect(button).toHaveAttribute('aria-expanded', 'true')
    expect(
      within(screen.getByRole('region', { name: 'Agent prompt' })).getByTestId('text-prose')
        .textContent,
    ).toBe(agentFixture.toolUse.input.prompt)
    expect(
      within(screen.getByRole('region', { name: 'Agent final report' })).getByTestId('text-prose')
        .textContent,
    ).toBe(agentFixture.toolResult.content[0].text)
  })

  it('uses live watcher state without depending on a screen channel', () => {
    const subagent: SubAgentState = {
      toolUseId: agentUse.id,
      agentId: 'agent-fixture-child',
      agentType: 'Explore',
      description: 'Inspect renderer ownership',
      status: 'running',
      startedAt: 1_000,
      lastActivityAt: 31_000,
      turnCount: 1,
      toolCalls: [
        { name: 'Read', headline: 'src/example.ts', status: 'done' },
        { name: 'Grep', headline: 'ownership', status: 'running' },
      ],
      droppedToolCalls: 0,
      currentActivity: 'running Grep',
    }
    render(contexts(<ClaudeAgentRow model={fromClaudeAgentUse(agentUse)!} />, { subagent }))
    const button = screen.getByRole('button', { name: /2 tools · 0:30/ })
    fireEvent.click(button)
    expect(screen.getByText('src/example.ts')).toBeInTheDocument()
    expect(screen.getByText('running Grep…')).toBeInTheDocument()
  })

  it('prefers a terminal notification label but does not duplicate its report after commit', () => {
    const notification: TaskNotification = {
      taskId: 'child',
      toolUseId: agentUse.id,
      status: 'completed',
      summary: null,
      result: 'Notification copy',
      outputFile: null,
      usage: '10 tokens',
    }
    render(
      contexts(<ClaudeAgentRow model={fromClaudeAgentUse(agentUse)!} />, {
        result: agentResult,
        notification,
      }),
    )
    const button = screen.getByRole('button', { name: /completed · 10 tokens/ })
    fireEvent.click(button)
    expect(screen.queryByText('Notification copy')).not.toBeInTheDocument()
    expect(screen.getByText(agentFixture.toolResult.content[0].text)).toBeInTheDocument()
  })

  it('routes Claude Agent through provider dispatch and records a valid result as absorbed', () => {
    expect(renderClaudeToolUse(agentUse)).toBeTruthy()
    expect(renderClaudeToolResult(agentResult, { sourceTool: agentUse })).toBeNull()
  })

  it('cuts the committed Claude block over while retaining the legacy Codex spawn fallback', () => {
    const { rerender } = render(
      contexts(
        <>
          <Block block={agentUse} role="assistant" />
          <Block block={agentResult} role="user" />
        </>,
        { result: agentResult },
      ),
    )
    const claudeButton = screen.getByRole('button', { name: /Explore.*done/ })
    fireEvent.click(claudeButton)
    expect(screen.getByRole('region', { name: 'Agent final report' })).toBeInTheDocument()

    const codexSpawn = {
      type: 'tool_use' as const,
      id: 'codex-spawn-fixture',
      name: 'spawn_agent',
      input: { agent_type: 'worker', message: 'Inspect another subsystem' },
    }
    rerender(contexts(<Block block={codexSpawn} role="assistant" />, { provider: 'codex' }))
    expect(
      screen.getByRole('button', { name: /worker.*Inspect another subsystem.*starting/ }),
    ).toBeInTheDocument()
  })
})
