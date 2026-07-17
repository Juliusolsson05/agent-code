import { describe, expect, it } from 'vitest'

import type { ToolResultBlock, ToolUseBlock } from '@shared/types/transcript'

import { fromClaudeQuestionResult, fromClaudeQuestionUse } from './questions'

describe('Claude question adapter', () => {
  const use: ToolUseBlock = {
    type: 'tool_use',
    id: 'question',
    name: 'AskUserQuestion',
    input: {
      questions: [{
        question: 'Which phase?',
        header: 'Next',
        multiSelect: false,
        options: [{ label: 'Phase 8', description: 'Continue the rewrite' }],
      }],
    },
  }

  it('admits only complete question input', () => {
    expect(fromClaudeQuestionUse(use)?.questions[0]?.question).toBe('Which phase?')
    expect(fromClaudeQuestionUse({ ...use, input: { questions: [] } })).toBeNull()
  })

  it('retains a verbatim result only when its carrier is lossless', () => {
    const model = fromClaudeQuestionUse(use)!
    const result: ToolResultBlock = {
      type: 'tool_result', tool_use_id: use.id, content: 'Phase 8',
    }
    expect(fromClaudeQuestionResult(result, model)).toBe('Phase 8')
    expect(fromClaudeQuestionResult({
      ...result,
      content: [{ type: 'text', text: 'Phase 8' }, { type: 'text', text: 'extra' }],
    }, model)).toBeNull()
    expect(fromClaudeQuestionResult({
      ...result,
      content: 'Question interrupted',
      is_error: true,
    }, model)).toBeNull()
  })
})
