import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { renderClaudeOperation } from '@providers/claude/renderer/rows/dispatch'
import { renderCodexOperation } from '@providers/codex/renderer/rows/dispatch'
import { renderOpencodeOperation } from '@providers/opencode/renderer/rows/dispatch'
import type { ProviderOperationInput } from '@shared/types/providerConfig'

function operation(
  provider: 'claude' | 'codex' | 'opencode',
  overrides: Partial<ProviderOperationInput> = {},
) {
  const toolUse = provider === 'claude'
    ? { type: 'tool_use' as const, id: 'git', name: 'Bash', input: { command: 'git status --short' } }
    : provider === 'codex'
      ? { type: 'tool_use' as const, id: 'git', name: 'exec_command', input: { cmd: 'git status --short' } }
      : { type: 'tool_use' as const, id: 'git', name: 'bash', input: { command: 'git status --short' } }
  const input: ProviderOperationInput = {
    toolUse,
    result: {
      type: 'tool_result',
      tool_use_id: 'git',
      content: ' M src/example.ts',
    },
    live: false,
    streaming: false,
    ...overrides,
  }
  return provider === 'claude'
    ? renderClaudeOperation(input)
    : provider === 'codex'
      ? renderCodexOperation(input)
      : renderOpencodeOperation(input)
}

describe('provider-owned Git operation formatting', () => {
  it.each(['claude', 'codex', 'opencode'] as const)(
    'claims %s only after its provider adapter validates the envelope',
    provider => {
      const decision = operation(provider)
      expect(decision.toolUse.action).toBe('render')
      if (decision.toolUse.action === 'render') {
        expect(decision.toolUse.receipt).toEqual({
          rendererId: 'shared.command',
          protocolId: 'command.git',
        })
      }
      expect(decision.toolResult).toMatchObject({
        action: 'absorb',
        ownerRenderId: 'shared.command',
        protocolId: 'command.git',
      })
    },
  )

  it('keeps a failed result visible inside the owning operation card', () => {
    const decision = operation('codex', {
      result: {
        type: 'tool_result',
        tool_use_id: 'git',
        content: 'fatal: authentication failed',
        is_error: true,
      },
    })
    expect(decision.toolUse.action).toBe('render')
    if (decision.toolUse.action === 'render') render(decision.toolUse.node)
    expect(screen.getAllByText('fatal: authentication failed')).toHaveLength(2)
    expect(screen.getByText('FAILED')).toBeInTheDocument()
  })

  it('keeps recognized Git formatting always on in the unreleased cutover', () => {
    const decision = operation('claude')
    expect(decision.toolUse.action).toBe('render')
    if (decision.toolUse.action === 'render') {
      expect(decision.toolUse.receipt).toEqual({
        rendererId: 'shared.command',
        protocolId: 'command.git',
      })
    }
    expect(decision.toolResult?.action).toBe('absorb')
  })

  it('does not infer one Git operation from an arbitrary unified exec script', () => {
    const decision = operation('codex', {
      toolUse: {
        type: 'tool_use',
        id: 'git',
        name: 'exec',
        input: { raw: 'const a = await tools.exec_command({cmd:"git status"}); const b = 1;' },
      },
    })
    expect(decision.toolUse.action).toBe('render')
    if (decision.toolUse.action === 'render') {
      expect(decision.toolUse.receipt.protocolId).not.toBe('command.git')
    }
    expect(decision.toolResult?.action).not.toBe('absorb')
  })

  it.each([
    'git status --short && npm test',
    'git commit -m "checkpoint" && npm test',
    'git diff; cat unrelated.log',
  ])('declines a mixed command chain without absorbing its combined result: %s', command => {
    const decision = operation('claude', {
      toolUse: {
        type: 'tool_use',
        id: 'git',
        name: 'Bash',
        input: { command },
      },
      result: {
        type: 'tool_result',
        tool_use_id: 'git',
        content: ' M src/example.ts\nunrelated command output',
      },
    })

    expect(decision.toolUse.action).toBe('render')
    if (decision.toolUse.action === 'render') {
      expect(decision.toolUse.receipt.protocolId).not.toBe('command.git')
    }
    expect(decision.toolResult?.action).not.toBe('absorb')
  })

  it('keeps all-Git chains eligible while retaining their combined raw evidence', () => {
    const output = '[main abc1234] checkpoint\nwarning: hook emitted additional context'
    const decision = operation('claude', {
      toolUse: {
        type: 'tool_use',
        id: 'git',
        name: 'Bash',
        input: { command: 'git status --short && git add -A && git commit -m "checkpoint"' },
      },
      result: {
        type: 'tool_result',
        tool_use_id: 'git',
        content: output,
      },
    })

    expect(decision.toolUse.action).toBe('render')
    if (decision.toolUse.action !== 'render') return
    expect(decision.toolUse.receipt.protocolId).toBe('command.git')
    expect(decision.toolResult?.action).toBe('absorb')

    render(decision.toolUse.node)
    expect(screen.queryByText('warning: hook emitted additional context')).not.toBeInTheDocument()
    const details = screen.getByText(/view raw output/).closest('details')!
    fireEvent.click(details.querySelector('summary')!)
    expect(details.querySelector('pre')?.textContent).toBe(output)
  })

  it('retains warning lines ignored by a successful structured status parser', () => {
    const output = ' M src/example.ts\nwarning: status advice from a newer Git version'
    const decision = operation('codex', {
      result: {
        type: 'tool_result',
        tool_use_id: 'git',
        content: output,
      },
    })

    expect(decision.toolUse.action).toBe('render')
    if (decision.toolUse.action !== 'render') return
    render(decision.toolUse.node)
    expect(screen.queryByText('warning: status advice from a newer Git version')).not.toBeInTheDocument()
    const details = screen.getByText(/view raw output/).closest('details')!
    fireEvent.click(details.querySelector('summary')!)
    expect(details.querySelector('pre')?.textContent).toBe(output)
  })
})
