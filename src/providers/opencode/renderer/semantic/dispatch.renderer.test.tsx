import { describe, expect, it } from 'vitest'

import { renderOpencodeSemanticBlock } from '@providers/opencode/renderer/semantic/dispatch'
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

describe('OpenCode semantic provider boundary', () => {
  it('owns proven live todo and Git bash shapes through provider dispatch', () => {
    expect(renderOpencodeSemanticBlock(block({
      toolName: 'todowrite',
      toolUseId: 'todo-live',
      parsedInput: {
        todos: [{ content: 'Verify renderer', status: 'in_progress', priority: 'high' }],
      },
    }), context)).toEqual(expect.objectContaining({
      action: 'render',
      receipt: { rendererId: 'opencode.rows.dispatch' },
    }))

    expect(renderOpencodeSemanticBlock(block({
      toolName: 'bash',
      toolUseId: 'bash-live',
      parsedInput: {
        command: 'git status --short',
        description: 'Shows repository changes',
        timeout: 120000,
        workdir: '/workspace/project',
      },
    }), context)).toEqual(expect.objectContaining({
      action: 'render',
      receipt: { rendererId: 'shared.command', protocolId: 'command.git' },
    }))
  })

  it('declines generic live tool shapes back to the shared semantic fallback', () => {
    expect(renderOpencodeSemanticBlock(block({
      toolName: 'grep',
      toolUseId: 'grep-live',
      parsedInput: {
        pattern: 'renderSemanticBlock',
        path: '/workspace/project/src',
        include: '*.ts',
      },
    }), context)).toEqual({ action: 'fallback' })
  })

  it('keeps live read on a provider-owned result path even though the invocation stays generic', () => {
    expect(renderOpencodeSemanticBlock(block({
      toolName: 'read',
      toolUseId: 'read-live',
      parsedInput: {
        filePath: '/workspace/project/src/example.ts',
        offset: 1,
        limit: 2,
      },
      resultAt: 1,
      resultContent: '<path>/workspace/project/src/example.ts</path>\n<type>file</type>\n<content>\n1: export const answer = 42\n2: export type Answer = number\n</content>',
    }), context)).toEqual(expect.objectContaining({
      action: 'render',
      receipt: { rendererId: 'opencode.rows.dispatch' },
    }))
  })

  it('owns live apply_patch once the direct patchText closes a real file header', () => {
    expect(renderOpencodeSemanticBlock(block({
      toolName: 'apply_patch',
      toolUseId: 'patch-live',
      parsedInput: {
        patchText: '*** Begin Patch\n*** Update File: src/example.ts\n@@\n-old\n+new\n*** End Patch',
      },
    }), context)).toEqual(expect.objectContaining({
      action: 'render',
      receipt: { rendererId: 'opencode.rows.dispatch' },
    }))
  })
})
