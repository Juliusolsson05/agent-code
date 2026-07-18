import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { CodeRenderContext } from '@renderer/features/feed/context'

import { parseStructuredOutput } from './model'
import { StructuredOutputView } from './StructuredOutputView'

vi.mock('@renderer/lib/code/CodeBlock', () => ({
  CodeBlock: ({ code }: { code: string }) => <pre data-testid="code-block">{code}</pre>,
}))

describe('StructuredOutputView', () => {
  it('keeps large JSON lazy while exposing provenance and exact source', () => {
    const source = [
      'Warning: truncated output (original token count: 30028)',
      'testing/fixtures/rendering-bundles/example.json:1:{"meta":{"kind":"codex"},"entries":[1,2]}',
    ].join('\n')
    const model = parseStructuredOutput(source)
    expect(model).not.toBeNull()

    const { container } = render(
      <CodeRenderContext.Provider value={{ sessionId: 'fixture', workspaceRoot: '/workspace' }}>
        <StructuredOutputView model={model!} source={source} />
      </CodeRenderContext.Provider>,
    )

    expect(screen.getByText('1 structured record', { exact: false })).toBeInTheDocument()
    expect(screen.getByText('Warning: truncated output (original token count: 30028)')).toBeInTheDocument()
    expect(screen.getByText('testing/fixtures/rendering-bundles/example.json:1')).toBeInTheDocument()
    expect(screen.queryByTestId('code-block')).not.toBeInTheDocument()

    fireEvent.click(screen.getByText('testing/fixtures/rendering-bundles/example.json:1'))
    expect(screen.getByTestId('code-block')).toHaveTextContent('"kind": "codex"')
    expect(screen.queryByText(source)).not.toBeInTheDocument()

    fireEvent.click(screen.getByText('View exact paged output'))
    expect(Array.from(container.querySelectorAll('pre')).some(node => node.textContent === source)).toBe(true)
  })
})
