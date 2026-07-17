import { describe, expect, it } from 'vitest'

import { renderClaudeSemanticBlock } from '@providers/claude/renderer/semantic/dispatch'
import type { SemanticLiveBlock } from '@renderer/session-runtime/state'
import type { ToolResultBlock } from '@shared/types/transcript'

const context = {
  committedToolResults: new Map<string, ToolResultBlock>(),
}

function block(overrides: Partial<SemanticLiveBlock>): SemanticLiveBlock {
  return {
    blockIndex: 0,
    kind: 'tool_use',
    finalized: true,
    ...overrides,
  }
}

describe('Claude semantic provider boundary', () => {
  it('owns complete Bash/Edit/Write inputs through provider components', () => {
    expect(renderClaudeSemanticBlock(block({
      toolName: 'Bash',
      toolUseId: 'bash',
      parsedInput: { command: 'printf ok' },
      inputJson: '{"command":"printf ok"}',
      inputJsonValid: true,
    }), context)).not.toBeUndefined()

    expect(renderClaudeSemanticBlock(block({
      toolName: 'Edit',
      toolUseId: 'edit',
      parsedInput: { file_path: '/workspace/a.ts', old_string: 'a', new_string: 'b' },
      inputJsonValid: true,
    }), context)).not.toBeUndefined()

    expect(renderClaudeSemanticBlock(block({
      toolName: 'Write',
      toolUseId: 'write',
      parsedInput: { file_path: '/workspace/a.ts', content: 'export {}' },
      inputJsonValid: true,
    }), context)).not.toBeUndefined()
  })

  it('declines provider-neutral text and edit prefixes before identity closes', () => {
    // WHY these declines are asserted beside the positive routes: the catalog
    // deliberately keeps Edit/Write prefix outcomes planned. Tightening them
    // to specialized would turn the honest early generic row into a misroute.
    expect(renderClaudeSemanticBlock(block({
      kind: 'text',
      text: 'hello',
    }), context)).toBeUndefined()
    expect(renderClaudeSemanticBlock(block({
      toolName: 'Edit',
      finalized: false,
      inputJson: '{"file_path":"',
    }), context)).toBeUndefined()
    expect(renderClaudeSemanticBlock(block({
      toolName: 'Write',
      finalized: false,
      inputJson: '{"file_path":"',
    }), context)).toBeUndefined()
  })
})
