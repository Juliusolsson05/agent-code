import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import type { AgentWorkContext } from '@shared/work-context/types'

import { ScrollIndicator } from './ScrollIndicator'

const longWorktree: AgentWorkContext = {
  worktreePath: '/workspace/.worktrees/feature-with-a-deliberately-long-name',
  branch: 'feature/issue-552-deliberately-long-worktree-name',
  repoRoot: '/workspace',
  confidence: 'explicit',
  source: 'test',
  updatedAt: 1,
}

describe('ScrollIndicator', () => {
  it('wraps between complete status badges when a tiled pane is narrow', () => {
    const { container } = render(
      <ScrollIndicator
        entryCount={50}
        totalEntries={100}
        scrollFraction={0.5}
        tailMode
        sessionKind="claude"
        workContext={longWorktree}
        workActivity={null}
      />,
    )

    const shell = container.firstElementChild
    const items = shell?.firstElementChild

    // WHY assert the utility contract directly: happy-dom intentionally has no layout engine, so
    // fabricated scrollWidth values would not prove the production CSS wraps. These are the exact
    // constraints whose absence caused #552; pinning them prevents the responsive behavior from
    // being silently simplified back into an overflowing max-content row.
    expect(shell).toHaveClass('min-w-0')
    expect(items).toHaveClass('w-full', 'min-w-0', 'flex-wrap', 'justify-end')
    expect(screen.getByText(longWorktree.branch!)).toHaveClass('min-w-0', 'truncate')
    expect(screen.getByText('Claude Code')).toHaveClass('shrink-0', 'whitespace-nowrap')
    expect(screen.getByText('TAIL')).toHaveClass('shrink-0', 'whitespace-nowrap')
    expect(screen.getByText('75/100')).toHaveClass('shrink-0', 'whitespace-nowrap')
  })
})
