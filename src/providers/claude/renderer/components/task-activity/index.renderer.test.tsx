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

describe('ClaudeTaskActivityRow', () => {
  it('renders a task lifecycle once and absorbs the acknowledgement result', () => {
    const use: ToolUseBlock = {
      type: 'tool_use',
      id: 'create',
      name: 'TaskCreate',
      input: {
        subject: 'Audit renderer',
        description: 'Read every provider route',
        activeForm: 'Auditing renderer',
      },
    }
    const result: ToolResultBlock = {
      type: 'tool_result',
      tool_use_id: use.id,
      content: 'Task #7 created successfully: Audit renderer',
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

    expect(screen.getByText('Create task')).toBeInTheDocument()
    expect(screen.getByText('Audit renderer')).toBeInTheDocument()
    expect(screen.getByText('created')).toBeInTheDocument()
    expect(screen.queryAllByText(/created successfully/)).toHaveLength(0)

    fireEvent.click(screen.getByRole('button'))
    expect(screen.getByText('Read every provider route')).toBeInTheDocument()
    expect(screen.getByText(/created successfully/)).toBeInTheDocument()
  })
})
