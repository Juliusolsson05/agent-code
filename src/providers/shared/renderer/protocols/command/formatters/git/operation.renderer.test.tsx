import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { renderClaudeOperation } from '@providers/claude/renderer/rows/dispatch'
import { renderCodexOperation } from '@providers/codex/renderer/rows/dispatch'
import { renderOpencodeOperation } from '@providers/opencode/renderer/rows/dispatch'
import { GitDiffCard, GitLogCard } from './GitOperationView'
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
  it('keeps GitDiffCard hook order stable across raw/unified intent transitions', () => {
    const unified = {
      kind: 'diff' as const,
      flags: [],
      paths: [],
      staged: false,
      nameOnly: false,
      stat: false,
    }
    const raw = { ...unified, flags: ['--stat'], stat: true }
    const output = [
      'diff --git a/a.ts b/a.ts',
      '--- a/a.ts',
      '+++ b/a.ts',
      '@@ -1 +1 @@',
      '-old',
      '+new',
    ].join('\n')

    const unifiedFirst = render(<GitDiffCard intent={unified} output={output} />)
    expect(() => unifiedFirst.rerender(<GitDiffCard intent={raw} output={'a.ts | 2 +-'} />)).not.toThrow()
    unifiedFirst.unmount()

    const rawFirst = render(<GitDiffCard intent={raw} output={'a.ts | 2 +-'} />)
    expect(() => rawFirst.rerender(<GitDiffCard intent={unified} output={output} />)).not.toThrow()
  })

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
    'git commit -m "checkpoint" | cat',
    'git commit -m "checkpoint" || git status',
    'git commit -m "checkpoint" & git status',
    'git commit -m "checkpoint" > commit.log',
    'git commit -m "checkpoint"\nprintf "unrelated"',
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

  it('qualifies bounded status counts instead of calling a parsed prefix complete', () => {
    const output = Array.from({ length: 401 }, (_, index) => ` M src/${index}.ts`).join('\n')
    const decision = operation('codex', {
      result: { type: 'tool_result', tool_use_id: 'git', content: output },
    })

    if (decision.toolUse.action !== 'render') throw new Error('expected Git render')
    render(decision.toolUse.node)
    expect(screen.getByText('Modified (≥400)')).toBeInTheDocument()
    expect(screen.getByText(/Status counts cover only the parsed prefix/)).toBeInTheDocument()
    expect(screen.queryByText('working tree clean')).not.toBeInTheDocument()
  })

  it('marks bounded diff file/change totals as proven lower bounds', () => {
    const output = [
      'diff --git a/a.ts b/a.ts',
      'index abc1234..def5678 100644',
      '--- a/a.ts',
      '+++ b/a.ts',
      '@@ -1,0 +1,396 @@',
      ...Array.from({ length: 396 }, (_, index) => `+line ${index}`),
    ].join('\n')
    const decision = operation('claude', {
      toolUse: {
        type: 'tool_use', id: 'git', name: 'Bash', input: { command: 'git diff' },
      },
      result: { type: 'tool_result', tool_use_id: 'git', content: output },
    })

    if (decision.toolUse.action !== 'render') throw new Error('expected Git render')
    render(decision.toolUse.node)
    expect(screen.getByText('≥1 file')).toBeInTheDocument()
    expect(screen.getAllByText('+≥395').length).toBeGreaterThan(0)
    expect(screen.getByText(/Counts are proven lower bounds/)).toBeInTheDocument()
  })

  it('discloses a bounded log as a prefix rather than implying a complete log', () => {
    const output = Array.from(
      { length: 401 },
      (_, index) => `${index.toString(16).padStart(7, '0')} commit ${index}`,
    ).join('\n')
    const decision = operation('opencode', {
      toolUse: {
        type: 'tool_use', id: 'git', name: 'bash', input: { command: 'git log --oneline' },
      },
      result: { type: 'tool_result', tool_use_id: 'git', content: output },
    })

    if (decision.toolUse.action !== 'render') throw new Error('expected Git render')
    render(decision.toolUse.node)
    expect(screen.getByText(/Showing 400 complete commits from the parsed prefix/)).toBeInTheDocument()
    expect(screen.queryByText('(no commits)')).not.toBeInTheDocument()
  })

  it('does not count the uncertain final block of a bounded full-format log', () => {
    const intent = { kind: 'log' as const, oneline: false }
    const output = [
      'commit aaaaaaa',
      'Author: A <a@example.com>',
      'Date: today',
      '',
      '    complete subject',
      '',
      'commit bbbbbbb',
      'Author: B <b@example.com>',
    ].join('\n')

    render(<GitLogCard intent={intent} output={output} partial />)
    expect(screen.getByText('complete subject')).toBeInTheDocument()
    expect(screen.queryByText('bbbbbbb')).not.toBeInTheDocument()
    expect(screen.getByText(/Showing 1 complete commit from the parsed prefix/)).toBeInTheDocument()
  })

  it('drops a character-capped partial line instead of parsing a plausible stats prefix', () => {
    const header = '[main abc1234] subject\n'
    const stats = ' 9 files changed, 123 insertions(+), 45 deletions(-)'
    const output = `${header}${' '.repeat((16 * 1024) - header.length - 20)}${stats}`
    const decision = operation('claude', {
      toolUse: {
        type: 'tool_use', id: 'git', name: 'Bash', input: { command: 'git commit -m "subject"' },
      },
      result: { type: 'tool_result', tool_use_id: 'git', content: output },
    })

    if (decision.toolUse.action !== 'render') throw new Error('expected Git render')
    render(decision.toolUse.node)
    expect(screen.getByText('subject')).toBeInTheDocument()
    expect(screen.queryByText(/9 files changed/)).not.toBeInTheDocument()
    expect(screen.getByText(/Structured preview is partial/)).toBeInTheDocument()
  })

  it('bounds the highlighted command headline on failed Git operations', () => {
    const command = `git status ${'x'.repeat(10_000)}`
    const decision = operation('claude', {
      toolUse: { type: 'tool_use', id: 'git', name: 'Bash', input: { command } },
      result: {
        type: 'tool_result', tool_use_id: 'git', content: 'fatal: bad invocation', is_error: true,
      },
    })

    if (decision.toolUse.action !== 'render') throw new Error('expected Git render')
    const { container } = render(decision.toolUse.node)
    const headline = container.querySelector('.hljs')
    expect(headline?.textContent?.length).toBeLessThanOrEqual(161)
    expect(headline?.getAttribute('title')?.length).toBeLessThanOrEqual(161)
  })
})
