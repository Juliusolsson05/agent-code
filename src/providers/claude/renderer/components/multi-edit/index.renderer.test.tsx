import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { MultiEditRow } from '.'
import { renderClaudeOperation } from '@providers/claude/renderer/rows/dispatch'
import type { ToolUseBlock } from '@shared/types/transcript'

function multiEdit(edits: unknown[]): ToolUseBlock {
  return {
    type: 'tool_use',
    id: 'multi',
    name: 'MultiEdit',
    input: { file_path: '/workspace/a.ts', edits },
  }
}

describe('Claude MultiEdit paging', () => {
  it('keeps the tail reachable and renders malformed page members without throwing', () => {
    const edits = [
      ...Array.from({ length: 20 }, (_, index) => ({
        old_string: `before ${index}`,
        new_string: `after ${index}`,
      })),
      null,
      { old_string: 'tail before', new_string: 'tail after' },
    ]

    render(<MultiEditRow block={multiEdit(edits)} />)

    expect(screen.getByText('changes 1–20 of 22')).toBeTruthy()
    expect(screen.queryByText('unrecognized change 21 / 22')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'next' }))

    expect(screen.getByText('changes 21–22 of 22')).toBeTruthy()
    expect(screen.getByText('unrecognized change 21 / 22')).toBeTruthy()
    expect(screen.getByText('View raw change input')).toBeTruthy()
    expect(screen.getByText('tail after')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'previous' })).toBeTruthy()
  })

  it.each([
    ['missing edits', { file_path: '/workspace/a.ts' }],
    ['non-array edits', { file_path: '/workspace/a.ts', edits: { old_string: 'a' } }],
    ['blank file path', { file_path: ' ', edits: [] }],
  ])('declines a malformed top-level envelope: %s', (_label, input) => {
    const decision = renderClaudeOperation({
      toolUse: {
        type: 'tool_use',
        id: 'malformed-multi',
        name: 'MultiEdit',
        input,
      },
      result: null,
      live: false,
      streaming: false,
    })

    expect(decision.toolUse.action).toBe('fallback')
  })
})
