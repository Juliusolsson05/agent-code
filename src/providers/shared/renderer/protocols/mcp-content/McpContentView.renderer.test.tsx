import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { GenericLiveResult } from '@providers/shared/renderer/rows/GenericLiveResult'

import { McpContentView } from './McpContentView'
import { parseMcpContentResult } from './model'

vi.mock('@renderer/lib/code/CodeBlock', () => ({
  CodeBlock: ({ code }: { code: string }) => <pre data-testid="code-block">{code}</pre>,
}))

describe('McpContentView', () => {
  it('keeps media lazy and renders typed blocks with protocol hierarchy', () => {
    const model = parseMcpContentResult({
      content: [
        { type: 'text', text: 'A readable result' },
        { type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' },
        { type: 'resource_link', uri: 'https://example.com/report', name: 'Report' },
      ],
    })!
    render(<McpContentView model={model} />)

    expect(screen.getByText(/MCP result · 1 text · 1 image · 1 resource link/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Report' })).toHaveAttribute('href', 'https://example.com/report')
    expect(screen.queryByRole('img')).not.toBeInTheDocument()

    fireEvent.click(screen.getByText('image · image/png'))
    expect(screen.getByRole('img')).toHaveAttribute('src', 'data:image/png;base64,aGVsbG8=')
  })

  it('preserves exact transport bytes instead of reserializing the parsed carrier', () => {
    const source = '{ "content" : [ { "type" : "text", "text" : "exact" } ] }'
    const model = parseMcpContentResult(source)!
    render(<McpContentView model={model} source={source} />)

    expect(screen.queryByText(source)).not.toBeInTheDocument()
    fireEvent.click(screen.getByText('View exact MCP result'))
    expect(screen.getByText(source)).toBeInTheDocument()
  })

  it('keeps the typed MCP owner above the generic JSON parser budget', () => {
    const source = JSON.stringify({
      content: [{ type: 'text', text: 'x'.repeat(300_000) }],
    })
    render(<GenericLiveResult source={source} isError={false} />)

    // WHY 300 KiB: this crosses tryExtractJson's deliberately smaller 256 KiB budget while staying
    // inside parseMcpContentResult's 1 MiB protocol budget. Presentation must follow the parser that
    // actually proved the carrier rather than silently changing to a generic structured record.
    expect(screen.getByText(/MCP result · 1 text/)).toBeInTheDocument()
  })

  it('keeps a small non-transparent typed carrier under MCP ownership', () => {
    const source = JSON.stringify({
      content: [{ type: 'text', text: 'plain prose result' }],
    })
    render(<GenericLiveResult source={source} isError={false} />)

    // The generic parser preserves this carrier because its text is not JSON;
    // the raw-value recovery condition must not accidentally make MCP
    // ownership exclusive to oversized inputs.
    expect(screen.getByText(/MCP result · 1 text/)).toBeInTheDocument()
  })

  it('preserves peeled domain JSON ownership for a small transparent MCP carrier', () => {
    const source = JSON.stringify({
      content: [{ type: 'text', text: JSON.stringify({ ok: true, runId: 'r1' }) }],
    })
    render(<GenericLiveResult source={source} isError={false} />)

    // WHY the absence assertion matters: both parsers legitimately recognize
    // this wire value. The generic parser goes one step further and proves the
    // carrier is transparent, so rendering MCP chrome here would regress the
    // domain payload even though the happy-path summary still looked valid.
    expect(screen.getByText('ok: true')).toBeInTheDocument()
    expect(screen.queryByText(/MCP result/)).not.toBeInTheDocument()
  })
})
