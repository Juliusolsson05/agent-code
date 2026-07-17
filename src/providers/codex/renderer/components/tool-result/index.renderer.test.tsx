import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { CodeRenderContext } from '@renderer/features/feed/context'
import type { ToolResultBlock, ToolUseBlock } from '@shared/types/transcript'

import { CodexToolResultRow } from './index'

vi.mock('@renderer/lib/code/CodeBlock', () => ({
  CodeBlock: ({ code }: { code: string }) => <pre data-testid="code-block">{code}</pre>,
}))

describe('CodexToolResultRow structured output', () => {
  it('formats JSON-bearing search hits inside a unified exec envelope', () => {
    const sourceTool: ToolUseBlock = {
      type: 'tool_use',
      id: 'exec-cell',
      name: 'exec',
      input: {
        raw: 'const result = await tools.exec_command({cmd: "rg -n pattern testing/fixtures"});',
      },
    }
    const result = {
      type: 'tool_result',
      tool_use_id: sourceTool.id,
      content: [
        'Script completed',
        'Wall time: 0.3 seconds',
        'Output:',
        'Warning: truncated output (original token count: 30028)',
        'testing/fixtures/rendering-bundles/example.json:1:{"meta":{"kind":"codex"},"entries":[]}',
      ].join('\n'),
      codex: { kind: 'custom_tool_call_output' },
    } as ToolResultBlock & { codex: { kind: string } }

    render(
      <CodeRenderContext.Provider value={{ sessionId: 'fixture', workspaceRoot: '/workspace' }}>
        <CodexToolResultRow block={result} sourceTool={sourceTool} />
      </CodeRenderContext.Provider>,
    )

    expect(screen.getByText('1 structured record', { exact: false })).toBeInTheDocument()
    expect(screen.getByText('Warning: truncated output (original token count: 30028)')).toBeInTheDocument()
    expect(screen.getByText('testing/fixtures/rendering-bundles/example.json:1')).toBeInTheDocument()
    expect(screen.queryByText('Script completed')).not.toBeInTheDocument()
  })
})
