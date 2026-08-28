import { describe, expect, it } from 'vitest'

import committedFixture from '../../../../../../testing/fixtures/rendering-shapes/codex/exec/committed.json'
import { fromCodexCommandOperation } from '@providers/codex/renderer/adapters/command'
import { renderCodexOperation } from '@providers/codex/renderer/rows/dispatch'
import { classifyShellDiscovery } from '@providers/shared/renderer/protocols/discovery/classifyShellDiscovery'
import { composeDiscoveryOperation } from '@providers/shared/renderer/protocols/discovery/composeDiscoveryOperation'
import type { ToolResultBlock, ToolUseBlock } from '@shared/types/transcript'

type RecordedCase = {
  expectedReceipt?: { protocolId?: string }
  toolUse: ToolUseBlock
  toolResult?: ToolResultBlock
}

const recordedSearch = (committedFixture.cases as RecordedCase[]).find(
  sample => sample.expectedReceipt?.protocolId === 'command.search',
)

describe('recorded shell discovery admission', () => {
  it('classifies the captured compound rg search without losing command evidence', () => {
    if (!recordedSearch?.toolResult) throw new Error('recorded search fixture missing')
    const operation = fromCodexCommandOperation({
      toolUse: recordedSearch.toolUse,
      result: recordedSearch.toolResult,
      live: false,
      streaming: false,
    })
    if (!operation) throw new Error('recorded command did not normalize')

    const discovery = composeDiscoveryOperation(operation.model, operation.rawCommand)
    expect(discovery).toMatchObject({
      kind: 'search',
      protocolId: 'command.search',
      command: {
        status: 'unknown',
        exitCode: null,
      },
    })
    expect(discovery?.command.output).toContain('Total output lines: 877')
  })

  it('declines recorded mutation grammars instead of trusting a familiar command name', () => {
    const base = { label: 'exec', status: 'unknown' as const, exitCode: null }
    // These command forms were captured during the original command-protocol
    // work and already protect the file-mutation formatter in command.test.ts.
    expect(composeDiscoveryOperation(
      { ...base, command: "sed -i '' 's/a/b/' src/file.ts" },
      "sed -i '' 's/a/b/' src/file.ts",
    )).toBeNull()
    expect(composeDiscoveryOperation(
      { ...base, command: "cat > temp/x.ts <<'EOF'" },
      "cat > temp/x.ts <<'EOF'\nbody\nEOF",
    )).toBeNull()
    expect(composeDiscoveryOperation(
      { ...base, command: 'rg --pre transform needle .' },
      'rg --pre transform needle .',
    )).toBeNull()
  })

  it('distinguishes file enumeration from content search across a complete expression', () => {
    expect(classifyShellDiscovery('rg --files src')).toBe('list')
    expect(classifyShellDiscovery('rg --files src | head -n 20')).toBe('list')
    expect(classifyShellDiscovery('rg --files src | rg renderer')).toBe('search')

    const decision = renderCodexOperation({
      toolUse: {
        type: 'tool_use',
        id: 'rg-files-list',
        name: 'exec_command',
        input: { cmd: 'rg --files src' },
      },
      result: null,
      live: true,
      streaming: true,
    })
    expect(decision.toolUse).toMatchObject({
      action: 'render',
      receipt: { rendererId: 'shared.command', protocolId: 'command.list' },
    })
  })

  it('declines utility options that write output or launch helper programs', () => {
    // WHY these are contract tests rather than executed shell fixtures: the
    // regression is admission of standardized command grammar. Executing the
    // mutators would make the test destructive without providing stronger
    // evidence than the exact option forms found by independent review.
    expect(classifyShellDiscovery('sort -o/tmp/sorted input.txt')).toBeNull()
    expect(classifyShellDiscovery('sort --output=/tmp/sorted input.txt')).toBeNull()
    expect(classifyShellDiscovery('sort --compress-program=/tmp/mutator input.txt')).toBeNull()
    expect(classifyShellDiscovery(
      "rg -H --hostname-bin=/tmp/mutator --hyperlink-format='file://{host}{path}' needle target.txt",
    )).toBeNull()
  })

  it('keeps declined native commands on the neutral command receipt', () => {
    const toolUse: ToolUseBlock = {
      type: 'tool_use',
      id: 'sort-output-write',
      name: 'exec_command',
      input: { cmd: 'sort -o/tmp/sorted input.txt' },
    }
    const toolResult = {
      type: 'tool_result',
      tool_use_id: toolUse.id,
      content: '',
      is_error: false,
      codex: { kind: 'exec_command_end', exitCode: 0 },
    } as ToolResultBlock & { codex: { kind: string; exitCode: number } }

    const decision = renderCodexOperation({
      toolUse,
      result: toolResult,
      live: false,
      streaming: false,
    })
    expect(decision.toolUse).toMatchObject({
      action: 'render',
      receipt: { rendererId: 'codex.rows.dispatch' },
    })
    expect(
      decision.toolUse.action === 'render' && decision.toolUse.receipt,
    ).not.toHaveProperty('protocolId')
    expect(decision.toolResult).toMatchObject({
      action: 'absorb',
      ownerRenderId: 'codex.rows.dispatch',
    })
  })
})
