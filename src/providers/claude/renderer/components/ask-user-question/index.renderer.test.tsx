import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import {
  ProviderContext,
  ToolResultIndexContext,
  ToolUseIndexContext,
} from '@renderer/features/feed/context'
import { Block } from '@renderer/features/feed/ui/rows/Block'
import type { ToolResultBlock, ToolUseBlock } from '@shared/types/transcript'

describe('Claude provider-owned committed question', () => {
  it('renders question and answer once through provider dispatch', () => {
    const use: ToolUseBlock = {
      type: 'tool_use', id: 'question', name: 'AskUserQuestion', input: {
        questions: [{
          question: 'Continue the rewrite?',
          header: 'Phase 8',
          options: [{ label: 'Yes' }, { label: 'No' }],
        }],
      },
    }
    const result: ToolResultBlock = {
      type: 'tool_result', tool_use_id: use.id, content: 'Yes',
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

    expect(screen.getByText('Question')).toBeInTheDocument()
    expect(screen.getByText('Continue the rewrite?')).toBeInTheDocument()
    expect(screen.getByText('Yes · No')).toBeInTheDocument()
    expect(screen.getAllByText('Yes')).toHaveLength(1)
  })
})
