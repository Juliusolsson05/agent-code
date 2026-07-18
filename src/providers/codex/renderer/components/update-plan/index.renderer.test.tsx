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

describe('CodexPlanRow', () => {
  it('renders plan status and absorbs the paired Plan updated result', () => {
    const use: ToolUseBlock = {
      type: 'tool_use', id: 'plan', name: 'update_plan', input: {
        explanation: 'Phase 8 progress',
        plan: [
          { step: 'Audit', status: 'completed' },
          { step: 'Implement', status: 'in_progress' },
          { step: 'Replay', status: 'pending' },
        ],
      },
    }
    const result: ToolResultBlock = {
      type: 'tool_result', tool_use_id: use.id, content: 'Plan updated',
    }
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

    expect(screen.getByText('Plan')).toBeInTheDocument()
    expect(screen.getByText('Phase 8 progress')).toBeInTheDocument()
    expect(screen.getByText(/1\/3 complete · 1 active · updated/)).toBeInTheDocument()
    expect(screen.queryByText('Plan updated')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button'))
    expect(screen.getByText('Audit')).toBeInTheDocument()
    expect(screen.getByText('Implement')).toBeInTheDocument()
    expect(screen.getByText('Replay')).toBeInTheDocument()
  })
})
