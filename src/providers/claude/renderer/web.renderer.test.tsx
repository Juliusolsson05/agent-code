import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import webFetchFixture from '../../../../testing/fixtures/rendering-shapes/claude/web-fetch/final.json'
import webSearchFixture from '../../../../testing/fixtures/rendering-shapes/claude/web-search/final.json'
import {
  fromClaudeWebFetchResult,
  fromClaudeWebFetchUse,
  fromClaudeWebSearchResult,
  fromClaudeWebSearchUse,
} from '@providers/claude/renderer/adapters/web'
import { ClaudeWebFetchRow } from '@providers/claude/renderer/components/web-fetch'
import { ClaudeWebFetchResultRow } from '@providers/claude/renderer/components/web-fetch-result'
import { ClaudeWebSearchRow } from '@providers/claude/renderer/components/web-search'
import { ClaudeWebSearchResultRow } from '@providers/claude/renderer/components/web-search-result'
import { renderClaudeOperation } from '@providers/claude/renderer/rows/dispatch'
import type { ToolResultBlock, ToolUseBlock } from '@shared/types/transcript'

// The provider component contract is lazy admission into the shared prose
// surface, not react-markdown's parser. Keeping this mock semantic proves that
// closed rows mount no parser child and that opening receives exact evidence.
vi.mock('@providers/shared/renderer/components/lazy-prose', () => ({
  LazyTextProse: ({ text }: { text: string }) => <div data-testid="text-prose">{text}</div>,
}))

const fetchUse = webFetchFixture.toolUse as ToolUseBlock
const fetchResult = webFetchFixture.toolResult as ToolResultBlock
const searchUse = webSearchFixture.toolUse as ToolUseBlock
const searchResult = webSearchFixture.toolResult as ToolResultBlock

describe('Claude provider-owned web components', () => {
  it('renders a safe compact fetch target without exposing query material in the label', () => {
    render(<ClaudeWebFetchRow model={fromClaudeWebFetchUse(fetchUse)!} />)
    const link = screen.getByRole('link', { name: 'example.com/docs/rendering' })
    expect(link).toHaveAttribute('href', 'https://example.com/docs/rendering?view=full')
    expect(screen.queryByText(/view=full/)).not.toBeInTheDocument()
    expect(screen.getByText('Summarize the documented rendering contract.')).toBeInTheDocument()
  })

  it('mounts fetched Markdown only while the result disclosure is open', () => {
    const model = fromClaudeWebFetchResult(fetchResult, fetchUse)!
    const { container } = render(<ClaudeWebFetchResultRow model={model} />)
    expect(screen.getByText(/Fetched/)).toHaveTextContent(
      'Fetched 5 lines from example.com/docs/rendering',
    )
    expect(screen.queryByTestId('text-prose')).not.toBeInTheDocument()

    const details = container.querySelector('details')!
    details.open = true
    fireEvent(details, new Event('toggle'))
    expect(screen.getByTestId('text-prose').textContent).toBe(fetchResult.content)

    details.open = false
    fireEvent(details, new Event('toggle'))
    expect(screen.queryByTestId('text-prose')).not.toBeInTheDocument()
  })

  it('renders web search query and lazily admitted results', () => {
    const model = fromClaudeWebSearchResult(searchResult, searchUse)!
    const { container } = render(
      <>
        <ClaudeWebSearchRow model={fromClaudeWebSearchUse(searchUse)!} />
        <ClaudeWebSearchResultRow model={model} />
      </>,
    )
    expect(screen.getAllByText('evidence backed rendering')).toHaveLength(2)
    expect(screen.getByText(/Web search returned/)).toHaveTextContent(
      'Web search returned 4 lines for evidence backed rendering',
    )
    expect(screen.queryByTestId('text-prose')).not.toBeInTheDocument()

    const details = container.querySelector('details')!
    details.open = true
    fireEvent(details, new Event('toggle'))
    expect(screen.getByTestId('text-prose').textContent).toBe(searchResult.content)
  })

  it('wires both operations and paired results through Claude dispatch', () => {
    const fetch = renderClaudeOperation({ toolUse: fetchUse, result: fetchResult, live: false, streaming: false })
    const search = renderClaudeOperation({ toolUse: searchUse, result: searchResult, live: false, streaming: false })
    render(
      <>
        {fetch.toolUse.action === 'render' ? fetch.toolUse.node : null}
        {fetch.toolResult?.action === 'render' ? fetch.toolResult.node : null}
        {search.toolUse.action === 'render' ? search.toolUse.node : null}
        {search.toolResult?.action === 'render' ? search.toolResult.node : null}
      </>,
    )
    expect(screen.getAllByText('example.com/docs/rendering')).toHaveLength(2)
    expect(screen.getAllByText('evidence backed rendering')).toHaveLength(2)
    expect(screen.queryByTestId('text-prose')).not.toBeInTheDocument()
  })
})
