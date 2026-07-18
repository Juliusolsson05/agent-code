import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { renderCodexOperation } from '@providers/codex/renderer/rows/dispatch'
import { ProviderContext } from '@renderer/features/feed/context'
import { SemanticLiveBlockRow } from '@renderer/features/feed/ui/semantic/BlockRow'
import type { SemanticLiveTurn } from '@renderer/session-runtime/state'
import type { ToolUseBlock } from '@shared/types/transcript'

describe('Codex provider-owned web component', () => {
  it('renders the same truthful search grammar on semantic and committed planes', () => {
    const committed: ToolUseBlock = {
      type: 'tool_use',
      id: 'web-committed',
      name: 'web_search',
      input: { kind: 'search', query: 'Agent Code rendering', status: 'completed' },
    }
    const semantic = {
      kind: 'web_search_call',
      blockIndex: 0,
      itemId: 'ws-live',
      webSearchAction: { kind: 'search', query: 'Agent Code rendering' },
      status: 'completed',
      finalized: true,
    } as SemanticLiveTurn['blocks'][number]
    const operation = renderCodexOperation({
      toolUse: committed,
      result: null,
      live: false,
      streaming: false,
    })

    render(
      <ProviderContext.Provider value="codex">
        {operation.toolUse.action === 'render' ? operation.toolUse.node : null}
        <SemanticLiveBlockRow block={semantic} toolState={null} />
      </ProviderContext.Provider>,
    )

    // WHY this is two rows rather than an absorption assertion: the current
    // semantic `ws_*` id and the committed synthesized id have no proven join
    // key. Matching visual grammar is safe; hiding either event is not.
    expect(screen.getAllByText('Search web')).toHaveLength(2)
    expect(screen.getAllByText('Agent Code rendering')).toHaveLength(2)
    expect(screen.getAllByText('completed')).toHaveLength(2)
  })

  it('keeps open-page URLs as safe links without manufacturing page content', () => {
    const operation = renderCodexOperation({
      toolUse: {
      type: 'tool_use',
      id: 'web-open',
      name: 'web_search',
      input: { kind: 'open_page', url: 'https://example.com/docs' },
      },
      result: null,
      live: false,
      streaming: false,
    })
    render(operation.toolUse.action === 'render' ? operation.toolUse.node : null)
    expect(screen.getByRole('link', { name: 'https://example.com/docs' })).toHaveAttribute(
      'href',
      'https://example.com/docs',
    )
    expect(screen.queryByText(/result/i)).not.toBeInTheDocument()
  })
})
