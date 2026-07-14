import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import {
  MCP_INLINE_IMAGE_MAX_BASE64_CHARS,
  StructuredOutput,
} from '@renderer/features/feed/ui/kit/StructuredOutput'

import { StructuredOperationCard } from './StructuredOperationCard'

function openDetails(summary: HTMLElement) {
  const details = summary.closest('details')
  if (!details) throw new Error('expected summary to belong to details')
  details.open = true
  fireEvent(details, new Event('toggle'))
}

describe('StructuredOperationCard', () => {
  it('keeps partial protocol JSON out of the normal feed while preserving a debug escape hatch', () => {
    const secretPartial = '{"query":"needle-that-must-stay-collapsed'
    render(
      <StructuredOperationCard
        id="operation:claude:live-1"
        family="generic"
        toolName="future_search_tool"
        status="streaming"
        params={null}
        rawInput={secretPartial}
      />,
    )

    expect(screen.getByText('Receiving parameters…')).toBeTruthy()
    expect(screen.queryByText(secretPartial)).toBeNull()

    const sourceSummary = screen.getByText('Source input (debug)')
    openDetails(sourceSummary)
    // Syntax highlighting splits JSON punctuation/strings into spans, so the
    // disclosure's aggregate text — rather than one implementation span — is
    // the stable assertion.
    expect(sourceSummary.closest('details')?.textContent).toContain(secretPartial)
  })

  it('renders scalar parameters as values and leaves nested source data lazy', () => {
    render(
      <StructuredOperationCard
        id="mcp:lookup-1"
        family="mcp"
        toolName="mcp__docs__lookup"
        status="complete"
        server="docs"
        params={{
          query: 'rendering contract',
          docs: 'https://example.com/rendering',
          path: '/Users/test/project/src/feed.tsx',
          filters: { language: 'typescript' },
        }}
      />,
    )

    expect(screen.getByText('rendering contract')).toBeTruthy()
    const paramsSummary = screen.getByText('3 parameters')
    // ExpandSection deliberately does not mount CodeBlock before the user asks
    // for it; testing absence protects restored-feed performance as well as UI.
    expect(screen.queryByText('/Users/test/project/src/feed.tsx')).toBeNull()
    openDetails(paramsSummary)

    expect(
      screen.getByRole('link', { name: 'https://example.com/rendering' }).getAttribute('href'),
    ).toBe('https://example.com/rendering')
    expect(screen.getByText('/Users/test/project/src/feed.tsx')).toBeTruthy()
  })
})

describe('StructuredOutput', () => {
  it('keeps the exact JSON string source beside its interpreted view', () => {
    const source = '{\n  "value": 1,\n  "value": 2\n}'
    render(<StructuredOutput codeId="exact-json" value={source} />)

    // JSON interpretation necessarily resolves the duplicate key, but the
    // provider bytes are evidence and remain independently inspectable.
    expect(screen.getByText('2')).toBeTruthy()
    expect(screen.queryByText(source)).toBeNull()

    const summary = screen.getByText('Original JSON source (copyable)')
    openDetails(summary)
    expect(summary.closest('details')?.textContent).toContain(source)
  })

  it('renders MCP text and resource links from the typed content envelope', () => {
    render(
      <StructuredOutput
        codeId="mcp-result"
        value={JSON.stringify([
          { type: 'text', text: 'Found the authoritative reference.' },
          {
            type: 'resource_link',
            uri: 'https://example.com/reference',
            name: 'Rendering reference',
            description: 'Primary documentation',
          },
        ])}
      />,
    )

    expect(screen.getByText('Found the authoritative reference.')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Rendering reference' }).getAttribute('href')).toBe(
      'https://example.com/reference',
    )
    expect(screen.getByText('Primary documentation')).toBeTruthy()
  })

  it('surfaces useful scalar fields before the complete JSON disclosure', () => {
    render(
      <StructuredOutput
        codeId="plan-result"
        value={{
          ok: true,
          updated: 4,
          report: 'https://example.com/report',
          internal: { revision: 12 },
        }}
      />,
    )

    expect(screen.getByText('Completed')).toBeTruthy()
    expect(screen.getByText('updated')).toBeTruthy()
    expect(screen.getByText('4')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'https://example.com/report' })).toBeTruthy()
    expect(screen.getByText('Complete result · 4 fields')).toBeTruthy()
    expect(screen.queryByText('revision')).toBeNull()
  })

  it('mounts bounded MCP images only after explicit expansion', () => {
    render(
      <StructuredOutput
        value={[{
          type: 'image',
          name: 'Rendered chart',
          source: { media_type: 'image/png', data: 'iVBORw0KGgo=' },
        }]}
      />,
    )

    const summary = screen.getByText(/Rendered chart · .* encoded characters/)
    expect(screen.queryByRole('img', { name: 'Rendered chart' })).toBeNull()
    openDetails(summary)
    expect(screen.getByRole('img', { name: 'Rendered chart' }).getAttribute('src')).toBe(
      'data:image/png;base64,iVBORw0KGgo=',
    )
  })

  it('refuses an MCP image whose encoded payload exceeds the preview cap', () => {
    render(
      <StructuredOutput
        value={[{
          type: 'image',
          name: 'Oversized render',
          source: {
            media_type: 'image/png',
            data: 'A'.repeat(MCP_INLINE_IMAGE_MAX_BASE64_CHARS + 1),
          },
        }]}
      />,
    )

    expect(screen.queryByRole('img')).toBeNull()
    expect(screen.getByRole('status').textContent).toContain('Oversized render not previewed')
  })
})
