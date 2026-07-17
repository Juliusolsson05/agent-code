import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import {
  ProviderContext,
  ToolResultIndexContext,
  ToolUseIndexContext,
} from '@renderer/features/feed/context'
import { Block } from '@renderer/features/feed/ui/rows/Block'
import { SemanticLiveBlockRow } from '@renderer/features/feed/ui/semantic/BlockRow'
import type { SemanticLiveTurn } from '@renderer/session-runtime/state'
import type { ToolResultBlock, ToolUseBlock } from '@shared/types/transcript'

vi.mock('@renderer/lib/code/CodeBlock', () => ({
  CodeBlock: ({ code }: { code: string }) => <pre data-testid="code-block">{code}</pre>,
}))

const use: ToolUseBlock = {
  type: 'tool_use',
  id: 'create-child',
  name: 'mcp__agent_code__orchestration_create_agent',
  input: {
    kind: 'codex',
    title: 'Phase 7 consultant',
    prompt: 'Audit the collaboration renderer',
  },
}
const result: ToolResultBlock = {
  type: 'tool_result',
  tool_use_id: use.id,
  content: [{
    type: 'text',
    text: JSON.stringify({
      ok: true,
      agent: {
        sessionId: 'child-session',
        kind: 'codex',
        cwd: '/workspace',
        title: 'Phase 7 consultant',
        lifecycleState: 'running',
      },
      promptSubmitted: true,
    }),
  }],
}

function feedContexts(node: React.ReactNode) {
  return (
    <ProviderContext.Provider value="claude">
      <ToolUseIndexContext.Provider value={new Map([[use.id, use]])}>
        <ToolResultIndexContext.Provider value={new Map([[use.id, result]])}>
          {node}
        </ToolResultIndexContext.Provider>
      </ToolUseIndexContext.Provider>
    </ProviderContext.Provider>
  )
}

describe('Agent Code orchestration protocol view', () => {
  it('owns the namespaced MCP spawn and preserves its result inside one card', () => {
    render(feedContexts(
      <>
        <Block block={use} role="assistant" />
        <Block block={result} role="user" />
      </>,
    ))
    expect(screen.getByText('Agent Code MCP')).toBeInTheDocument()
    expect(screen.getByText('Phase 7 consultant')).toBeInTheDocument()
    expect(screen.getByText(/· running/)).toBeInTheDocument()
    expect(screen.queryByText('ok: true')).not.toBeInTheDocument()

    fireEvent.click(screen.getByText('Create agent').closest('summary')!)
    expect(screen.getByText('Protocol result')).toBeInTheDocument()
    expect(screen.getByText('child-session')).toBeInTheDocument()
  })

  it('leaves another MCP server with the generic structured fallback', () => {
    const external: ToolUseBlock = {
      ...use,
      id: 'external-spawn',
      name: 'mcp__external_fleet__orchestration_create_agent',
    }
    render(
      <ProviderContext.Provider value="claude">
        <Block block={external} role="assistant" />
      </ProviderContext.Provider>,
    )
    expect(screen.getByText('MCP · external_fleet')).toBeInTheDocument()
    expect(screen.queryByText('Agent Code MCP')).not.toBeInTheDocument()
  })

  it('uses the same owned card and absorbs a validated result on the semantic plane', () => {
    const live = {
      kind: 'mcp_tool_use',
      blockIndex: 0,
      toolName: use.name,
      toolUseId: use.id,
      parsedInput: use.input,
      inputJson: JSON.stringify(use.input),
      inputJsonValid: true,
      finalized: true,
      resultAt: 1,
      resultContent: result.content,
      resultIsError: false,
    } as SemanticLiveTurn['blocks'][number]

    render(
      <ProviderContext.Provider value="claude">
        <SemanticLiveBlockRow block={live} toolState={null} />
      </ProviderContext.Provider>,
    )
    expect(screen.getByText('Agent Code MCP')).toBeInTheDocument()
    expect(screen.getByText(/· running/)).toBeInTheDocument()
    expect(screen.queryByText('ok: true')).not.toBeInTheDocument()

    fireEvent.click(screen.getByText('Create agent').closest('summary')!)
    expect(screen.getByText('child-session')).toBeInTheDocument()
  })
})
