import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import type { TaskNotification } from '@providers/claude/renderer/adapters/taskNotification'
import { CodexNativeSpawnRow } from '@providers/codex/renderer/components/native-spawn'
import {
  SubAgentsContext,
  TaskNotificationsContext,
  ToolResultIndexContext,
} from '@renderer/features/feed/context'
import type { SubAgentState } from '@renderer/session-runtime/state'
import type { ToolResultBlock } from '@shared/types/transcript'

const operationId = 'spawn-codex-1'
const model = {
  operationId,
  agentType: 'reviewer',
  description: 'Review Codex rendering',
  prompt: 'Inspect only the Codex evidence.',
  variant: 'named-task' as const,
}
const committed: ToolResultBlock = {
  type: 'tool_result',
  tool_use_id: operationId,
  content: JSON.stringify({ task_name: 'reviewer' }),
}

function renderRow({
  subagent,
  notification,
}: {
  subagent?: SubAgentState
  notification?: TaskNotification
} = {}) {
  render(
    <ToolResultIndexContext.Provider value={new Map([[operationId, committed]])}>
      <SubAgentsContext.Provider value={subagent ? { [operationId]: subagent } : {}}>
        {/* This provider is intentionally adversarial. Codex has no
            task-notification grammar; injecting one proves the component no
            longer accepts a Claude compatibility side channel. */}
        <TaskNotificationsContext.Provider
          value={notification ? new Map([[operationId, notification]]) : new Map()}
        >
          <CodexNativeSpawnRow model={model} />
        </TaskNotificationsContext.Provider>
      </SubAgentsContext.Provider>
    </ToolResultIndexContext.Provider>,
  )
}

describe('Codex native spawn evidence precedence', () => {
  it('ignores impossible Claude task-notification state and uses the committed result', () => {
    renderRow({
      notification: {
        taskId: 'claude-only',
        toolUseId: operationId,
        status: 'completed',
        summary: null,
        result: 'This must not affect a Codex card.',
        outputFile: null,
        usage: '999 tokens',
      },
    })

    expect(screen.getByRole('button', {
      name: /Codex agent.*reviewer.*Review Codex rendering.*response received/,
    })).toBeInTheDocument()
    expect(screen.queryByText(/999 tokens/)).not.toBeInTheDocument()
  })

  it('prefers richer live subagent telemetry over the committed acknowledgement', () => {
    renderRow({
      subagent: {
        toolUseId: operationId,
        agentId: 'child-1',
        agentType: 'reviewer',
        description: 'Review Codex rendering',
        status: 'running',
        startedAt: 1_000,
        lastActivityAt: 2_000,
        turnCount: 1,
        toolCalls: [{ name: 'exec_command', headline: 'rg renderer', status: 'running' }],
        droppedToolCalls: 0,
        currentActivity: 'running exec_command',
      },
    })

    expect(screen.getByRole('button', {
      name: /Codex agent.*reviewer.*Review Codex rendering.*1 tool/,
    })).toBeInTheDocument()
    expect(screen.queryByText('response received')).not.toBeInTheDocument()
  })
})
