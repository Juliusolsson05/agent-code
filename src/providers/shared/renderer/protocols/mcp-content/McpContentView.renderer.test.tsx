import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

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
})
