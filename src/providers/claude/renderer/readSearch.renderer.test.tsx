import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import readFixture from '../../../../testing/fixtures/rendering-shapes/claude/read/final.json'
import toolSearchFixture from '../../../../testing/fixtures/rendering-shapes/claude/tool-search/final.json'
import {
  fromClaudeReadResult,
  fromClaudeReadUse,
  fromClaudeToolSearchResult,
  fromClaudeToolSearchUse,
} from '@providers/claude/renderer/adapters/readSearch'
import { ClaudeReadRow } from '@providers/claude/renderer/components/read'
import { ClaudeReadResultRow } from '@providers/claude/renderer/components/read-result'
import { ClaudeToolSearchRow } from '@providers/claude/renderer/components/tool-search'
import { ClaudeToolSearchResultRow } from '@providers/claude/renderer/components/tool-search-result'
import { renderClaudeOperation } from '@providers/claude/renderer/rows/dispatch'
import { CodeRenderContext, ProviderContext } from '@renderer/features/feed/context'
import { SemanticLiveBlockRow } from '@renderer/features/feed/ui/semantic/BlockRow'
import type { SemanticLiveTurn } from '@renderer/session-runtime/state'
import type { ToolResultBlock, ToolUseBlock } from '@shared/types/transcript'

// The component contract under test is disclosure ownership, labels, and the
// admitted page transform—not Monaco's editor lifecycle. A tiny semantic mock
// lets this test prove that closed reads mount no heavy child and that opening
// receives stripped source without turning a row test into an LSP integration.
vi.mock('@renderer/lib/code/CodeBlock', () => ({
  CodeBlock: ({
    code,
    transformPage,
  }: {
    code: string
    transformPage?: (page: string) => string
  }) => <pre data-testid="code-block">{transformPage ? transformPage(code) : code}</pre>,
}))

const readUse = readFixture.toolUse as ToolUseBlock
const readResult = readFixture.toolResult as ToolResultBlock
const searchUse = toolSearchFixture.toolUse as ToolUseBlock
const searchResult = toolSearchFixture.toolResult as unknown as ToolResultBlock

function withWorkspace(node: React.ReactNode) {
  return (
    <CodeRenderContext.Provider value={{ sessionId: 'fixture', workspaceRoot: '/workspace' }}>
      {node}
    </CodeRenderContext.Provider>
  )
}

describe('Claude provider-owned read/search components', () => {
  it('shows a workspace-relative Read target and the captured range fields', () => {
    render(withWorkspace(<ClaudeReadRow model={fromClaudeReadUse(readUse)!} />))
    expect(screen.getByText('src/example.ts')).toBeInTheDocument()
    expect(screen.getByText('offset 41 · limit 2')).toBeInTheDocument()
  })

  it('keeps read content unmounted until explicit expansion, then strips the provider gutter', () => {
    const model = fromClaudeReadResult(readResult, readUse)!
    const { container } = render(withWorkspace(<ClaudeReadResultRow model={model} />))
    expect(screen.getByText(/Read/)).toHaveTextContent('Read 2 lines from src/example.ts')
    expect(screen.queryByTestId('code-block')).not.toBeInTheDocument()

    const details = container.querySelector('details')!
    details.open = true
    fireEvent(details, new Event('toggle'))
    expect(screen.getByTestId('code-block').textContent).toBe(
      'export const answer = 42\nexport type Answer = number',
    )

    details.open = false
    fireEvent(details, new Event('toggle'))
    expect(screen.queryByTestId('code-block')).not.toBeInTheDocument()
  })

  it('renders tool discovery as structured references, not JSON archaeology', () => {
    render(
      <>
        <ClaudeToolSearchRow model={fromClaudeToolSearchUse(searchUse)!} />
        <ClaudeToolSearchResultRow model={fromClaudeToolSearchResult(searchResult, searchUse)!} />
      </>,
    )
    expect(screen.getByText('select:ExampleTool')).toBeInTheDocument()
    expect(
      screen.getByText(
        (_, element) => element?.tagName === 'SUMMARY' && element.textContent === 'Found 2 tools',
      ),
    ).toBeInTheDocument()
    expect(screen.getByRole('list', { name: 'Matched tools' })).toHaveTextContent(
      'ExampleToolExampleToolTwo',
    )
  })

  it('wires both invocation and paired result through Claude provider dispatch', () => {
    const read = renderClaudeOperation({ toolUse: readUse, result: readResult, live: false, streaming: false })
    const search = renderClaudeOperation({ toolUse: searchUse, result: searchResult, live: false, streaming: false })
    render(
      withWorkspace(
        <>
          {read.toolUse.action === 'render' ? read.toolUse.node : null}
          {read.toolResult?.action === 'render' ? read.toolResult.node : null}
          {search.toolUse.action === 'render' ? search.toolUse.node : null}
          {search.toolResult?.action === 'render' ? search.toolResult.node : null}
        </>,
      ),
    )
    expect(screen.getAllByText('src/example.ts')).toHaveLength(2)
    expect(
      screen.getByText(
        (_, element) => element?.tagName === 'SUMMARY' && element.textContent === 'Found 2 tools',
      ),
    ).toBeInTheDocument()
  })

  it('routes a parsed live Read through the same provider invocation and result components', () => {
    const live = {
      kind: 'tool_use',
      blockIndex: 0,
      toolName: 'Read',
      toolUseId: readUse.id,
      parsedInput: readUse.input,
      inputJson: JSON.stringify(readUse.input),
      inputJsonValid: true,
      finalized: true,
      resultAt: 1,
      resultContent: readResult.content,
      resultIsError: false,
    } as SemanticLiveTurn['blocks'][number]
    render(
      withWorkspace(
        <ProviderContext.Provider value="claude">
          <SemanticLiveBlockRow block={live} toolState={null} />
        </ProviderContext.Provider>,
      ),
    )
    expect(screen.getAllByText('src/example.ts')).toHaveLength(2)
    expect(screen.getByText((_, element) => (
      element?.tagName === 'SUMMARY' &&
      element.textContent === 'Read 2 lines from src/example.ts'
    ))).toBeInTheDocument()
  })
})
