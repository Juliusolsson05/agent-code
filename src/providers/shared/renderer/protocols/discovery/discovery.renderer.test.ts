import { describe, expect, it } from 'vitest'

import committedFixture from '../../../../../../testing/fixtures/rendering-shapes/codex/exec/committed.json'
import { fromCodexCommandOperation } from '@providers/codex/renderer/adapters/command'
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
})
