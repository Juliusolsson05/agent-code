import { describe, expect, it } from 'vitest'

import { renderCodexSemanticBlock } from '@providers/codex/renderer/semantic/dispatch'
import type { SemanticLiveBlock } from '@renderer/session-runtime/state'
import type { ToolResultBlock } from '@shared/types/transcript'

const context = {
  committedToolResults: new Map<string, ToolResultBlock>(),
}

function block(overrides: Partial<SemanticLiveBlock>): SemanticLiveBlock {
  return {
    blockIndex: 0,
    kind: 'function_call',
    finalized: true,
    ...overrides,
  }
}

describe('Codex semantic provider boundary', () => {
  it('owns deterministic patch and command shapes through provider components', () => {
    expect(renderCodexSemanticBlock(block({
      kind: 'custom_tool_call',
      toolName: 'apply_patch',
      callId: 'patch',
      finalized: false,
      argumentsJson: '*** Begin Patch\n*** Add File: a.ts\n+export {}',
    }), context)).not.toBeUndefined()

    expect(renderCodexSemanticBlock(block({
      toolName: 'exec_command',
      callId: 'command',
      parsedInput: { cmd: 'printf ok' },
      inputJsonValid: true,
    }), context)).not.toBeUndefined()
  })

  it('declines provider-neutral messages and unclassified unified-exec content', () => {
    expect(renderCodexSemanticBlock(block({
      kind: 'message',
      text: 'hello',
    }), context)).toBeUndefined()

    // Unified exec is intentionally content-dependent. An unknown script must
    // reach the total generic fallback instead of being claimed merely because
    // its outer tool is named `exec`.
    expect(renderCodexSemanticBlock(block({
      kind: 'custom_tool_call',
      toolName: 'exec',
      callId: 'exec',
      argumentsJson: 'const value = 1;',
    }), context)).toEqual({ action: 'fallback' })
  })
})
