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

  it('normalizes the captured transparent unified exec before Git formatting', () => {
    // Direct text(r.output) carrier: the output bytes are owned, but no exit
    // code survives this transport, so the Git route claims the pair while the
    // view stays in the neutral "exit unknown" grammar (rich success cards
    // require proven exit 0).
    const decision = operation('codex', {
      toolUse: {
        type: 'tool_use',
        id: 'git',
        name: 'exec',
        input: {
          raw: 'const r = await tools.exec_command({cmd:"git status --short",workdir:"/repo"}); text(r.output);',
        },
      },
      result: {
        type: 'tool_result',
        tool_use_id: 'git',
        content: 'Script completed\nWall time 0.1 seconds\nOutput:\n\n M src/example.ts',
        codex: { kind: 'custom_tool_call_output' },
      } as never,
    })

    expect(decision.toolUse.action).toBe('render')
    if (decision.toolUse.action !== 'render') return
    expect(decision.toolUse.receipt).toEqual({
      rendererId: 'shared.command',
      protocolId: 'command.git',
    })
    expect(decision.toolResult).toMatchObject({
      action: 'absorb',
      ownerRenderId: 'shared.command',
      protocolId: 'command.git',
    })
    const { container } = render(decision.toolUse.node)
    expect(screen.getByText('exit unknown')).toBeInTheDocument()
    expect(container.textContent).toContain('src/example.ts')
  })

  /** Serialized text(JSON.stringify(r)) carrier — the transport that DOES
   * prove the inner exit code and therefore unlocks the rich Git cards. */
  function serializedExecResult(output: string, exitCode = 0): string {
    return [
      'Script completed',
      'Wall time 0.4 seconds',
      'Output:',
      '',
      JSON.stringify({ exit_code: exitCode, output, wall_time_seconds: 0.4 }),
    ].join('\n')
  }

  it('renders the captured stash-and-verification chain as one proven Git workflow', () => {
    const command = 'git stash push -u -m "snapshot" && git status --short --branch && git rev-parse HEAD && git rev-parse origin/main && git stash list -1'
    const script = `const r = await tools.exec_command({cmd:${JSON.stringify(command)}}); text(JSON.stringify(r));`
    const sha = '1fa345713623811d8fe6a2708ddb180f8fc0188a'
    const output = [
      'Saved working directory and index state On main: snapshot',
      '## main...origin/main',
      sha,
      sha,
      'stash@{0}: On main: snapshot',
    ].join('\n')
    const decision = operation('codex', {
      toolUse: { type: 'tool_use', id: 'git', name: 'exec', input: { raw: script } },
      result: {
        type: 'tool_result',
        tool_use_id: 'git',
        content: serializedExecResult(output),
        codex: { kind: 'custom_tool_call_output' },
      } as never,
    })

    if (decision.toolUse.action !== 'render') throw new Error('expected Git workflow')
    const { container } = render(decision.toolUse.node)
    expect(screen.getByText('git stash and verify')).toBeInTheDocument()
    // The single stash line and the single porcelain branch header are each
    // uniquely attributable, so they may be promoted to summaries.
    expect(screen.getByText('stash@{0}: On main: snapshot')).toBeInTheDocument()
    expect(screen.getByText('Branch main...origin/main')).toBeInTheDocument()
    // Exit 0 was proven by the serialized carrier and every operator is `&&`,
    // so each step provably ran and succeeded.
    expect(screen.getAllByText('✓')).toHaveLength(5)
    expect(screen.getByText('complete')).toBeInTheDocument()
    // The ref-equality heuristic was removed: two equal hex lines in a
    // combined stream never proved WHICH refs matched.
    expect(screen.queryByText('HEAD matches origin/main')).toBeNull()
    // The exact hashes remain visible inline instead.
    expect(container.textContent).toContain(sha)
  })

  it('names a diff guard + mixed reset + status chain without command-derived claims', () => {
    const command = 'git diff --cached --quiet && git reset --mixed origin/main && git status --short --branch'
    const script = `const r = await tools.exec_command({cmd:${JSON.stringify(command)}}); text(JSON.stringify(r));`
    const output = [
      'Unstaged changes after reset:',
      'M\tdocs/rendering.md',
      'M\tsrc/renderer.ts',
      '## main...origin/main',
    ].join('\n')
    const decision = operation('codex', {
      toolUse: { type: 'tool_use', id: 'git', name: 'exec', input: { raw: script } },
      result: {
        type: 'tool_result',
        tool_use_id: 'git',
        content: serializedExecResult(output),
        codex: { kind: 'custom_tool_call_output' },
      } as never,
    })

    if (decision.toolUse.action !== 'render') throw new Error('expected Git workflow')
    const { container } = render(decision.toolUse.node)
    expect(screen.getByText('git reset and inspect')).toBeInTheDocument()
    expect(screen.getAllByText('✓')).toHaveLength(3)
    // Reset-mode prose was derived from the command STRING, not output — a
    // claim about a mutation is only honest when the output itself proves it.
    expect(screen.queryByText(/Mixed reset/)).toBeNull()
    // Changed-path counting matched loose two-letter prefixes and could count
    // prose; the literal reset output stays visible inline instead.
    expect(screen.queryByText(/changed paths?/)).toBeNull()
    expect(container.textContent).toContain('Unstaged changes after reset:')
    expect(container.textContent).toContain('M\tdocs/rendering.md')
  })

  it('refuses success chrome when a guard chain fails invisibly on the direct carrier', () => {
    // The guard exits 1, so the reset NEVER ran — but the harness still says
    // "Script completed" and the direct carrier drops the exit code. This is
    // the exact scenario that previously rendered "reset and inspect ·
    // complete ✓✓✓" for a chain that mutated nothing.
    const command = 'git diff --cached --quiet && git reset --mixed origin/main && git status --short --branch'
    const script = `const r = await tools.exec_command({cmd:${JSON.stringify(command)}}); text(r.output);`
    const decision = operation('codex', {
      toolUse: { type: 'tool_use', id: 'git', name: 'exec', input: { raw: script } },
      result: {
        type: 'tool_result',
        tool_use_id: 'git',
        content: 'Script completed\nWall time 0.3 seconds\nOutput:\n\n',
        codex: { kind: 'custom_tool_call_output' },
      } as never,
    })

    if (decision.toolUse.action !== 'render') throw new Error('expected neutral Git operation')
    expect(decision.toolUse.receipt).toEqual({
      rendererId: 'shared.command',
      protocolId: 'command.git',
    })
    render(decision.toolUse.node)
    expect(screen.getByText('exit unknown')).toBeInTheDocument()
    expect(screen.queryByText('✓')).toBeNull()
    expect(screen.queryByText('complete')).toBeNull()
    expect(screen.queryByText(/reset and inspect/)).toBeNull()
  })

  it('keeps broader single-verb output readable inline instead of one line', () => {
    const script = 'const r = await tools.exec_command({cmd:"git branch -a"}); text(JSON.stringify(r));'
    const output = '* main\n  feature/one\n  remotes/origin/main'
    const decision = operation('codex', {
      toolUse: { type: 'tool_use', id: 'git', name: 'exec', input: { raw: script } },
      result: {
        type: 'tool_result',
        tool_use_id: 'git',
        content: serializedExecResult(output),
        codex: { kind: 'custom_tool_call_output' },
      } as never,
    })

    if (decision.toolUse.action !== 'render') throw new Error('expected Git workflow')
    const { container } = render(decision.toolUse.node)
    expect(screen.getByText('git branch')).toBeInTheDocument()
    expect(container.textContent).toContain('* main')
    expect(container.textContent).toContain('feature/one')
    expect(container.textContent).toContain('remotes/origin/main')
  })

  it('does not manufacture a ref match from hash ordering', () => {
    // The first two hex lines are BOTH the HEAD hash (log then rev-parse);
    // origin/main differs. The removed heuristic claimed a match here.
    const command = 'git log --format=%H -1 && git rev-parse HEAD && git rev-parse origin/main'
    const script = `const r = await tools.exec_command({cmd:${JSON.stringify(command)}}); text(JSON.stringify(r));`
    const head = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    const origin = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
    const decision = operation('codex', {
      toolUse: { type: 'tool_use', id: 'git', name: 'exec', input: { raw: script } },
      result: {
        type: 'tool_result',
        tool_use_id: 'git',
        content: serializedExecResult([head, head, origin].join('\n')),
        codex: { kind: 'custom_tool_call_output' },
      } as never,
    })

    if (decision.toolUse.action !== 'render') throw new Error('expected Git workflow')
    const { container } = render(decision.toolUse.node)
    expect(screen.queryByText(/HEAD matches/)).toBeNull()
    expect(container.textContent).toContain(origin)
  })

  it('does not promote a stash identity from a multi-entry stash list', () => {
    const command = 'git stash push -m "wip" && git stash list'
    const script = `const r = await tools.exec_command({cmd:${JSON.stringify(command)}}); text(JSON.stringify(r));`
    const output = [
      'Saved working directory and index state On main: wip',
      'stash@{0}: On main: wip',
      'stash@{1}: On main: earlier',
      'stash@{2}: WIP on feature: oldest',
    ].join('\n')
    const decision = operation('codex', {
      toolUse: { type: 'tool_use', id: 'git', name: 'exec', input: { raw: script } },
      result: {
        type: 'tool_result',
        tool_use_id: 'git',
        content: serializedExecResult(output),
        codex: { kind: 'custom_tool_call_output' },
      } as never,
    })

    if (decision.toolUse.action !== 'render') throw new Error('expected Git workflow')
    const { container } = render(decision.toolUse.node)
    // No summary line may pick one of several stash refs (exact-text queries
    // match only summary rows; the inline slab is a single larger text node).
    expect(screen.queryByText('stash@{0}: On main: wip')).toBeNull()
    expect(screen.queryByText('stash@{2}: WIP on feature: oldest')).toBeNull()
    // Every entry stays visible verbatim in the inline output.
    expect(container.textContent).toContain('stash@{2}: WIP on feature: oldest')
  })

  it('does not count prose lines as changed paths', () => {
    const command = 'git stash push -m "wip" && git stash apply'
    const script = `const r = await tools.exec_command({cmd:${JSON.stringify(command)}}); text(JSON.stringify(r));`
    const output = [
      'Saved working directory and index state On main: wip',
      'AM I sure this ran',
      'OK done',
    ].join('\n')
    const decision = operation('codex', {
      toolUse: { type: 'tool_use', id: 'git', name: 'exec', input: { raw: script } },
      result: {
        type: 'tool_result',
        tool_use_id: 'git',
        content: serializedExecResult(output),
        codex: { kind: 'custom_tool_call_output' },
      } as never,
    })

    if (decision.toolUse.action !== 'render') throw new Error('expected Git workflow')
    render(decision.toolUse.node)
    expect(screen.queryByText(/changed paths?/)).toBeNull()
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
