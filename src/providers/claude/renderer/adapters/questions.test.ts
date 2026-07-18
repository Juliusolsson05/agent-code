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

  it('declines oversized control arrays rather than offering a partial interaction', () => {
    expect(fromClaudeQuestionUse({
      ...use,
      input: { questions: Array.from({ length: 5 }, () => ({
        question: 'Too many', options: [{ label: 'One' }],
      })) },
    })).toBeNull()
    expect(fromClaudeQuestionUse({
      ...use,
      input: { questions: [{
        question: 'Too many options',
        options: Array.from({ length: 21 }, (_, index) => ({ label: `Option ${index}` })),
      }] },
    })).toBeNull()
  })

  it('declines the whole interaction when any question or option member drifts', () => {
    expect(fromClaudeQuestionUse({
      ...use,
      input: {
        questions: [
          { question: 'Valid?', options: [{ label: 'Yes' }] },
          { question: 'Malformed', options: [null] },
        ],
      },
    })).toBeNull()
    expect(fromClaudeQuestionUse({
      ...use,
      input: {
        questions: [{
          question: 'Partially malformed?',
          options: [{ label: 'Yes' }, { description: 'missing label' }],
        }],
      },
    })).toBeNull()
    expect(fromClaudeQuestionUse({
      ...use,
      input: {
        questions: [{ question: 'Bad optional field', header: 42, options: [{ label: 'Yes' }] }],
      },
    })).toBeNull()
    expect(fromClaudeQuestionUse({
      ...use,
      input: {
        questions: [{
          question: 'Bad option detail',
          options: [{ label: 'Yes', preview: { type: 'future-preview' } }],
        }],
      },
    })).toBeNull()
  })

  it('bounds question text before the DOM while retaining exact resolver values', () => {
    const model = fromClaudeQuestionUse({
      ...use,
      input: {
        questions: Array.from({ length: 4 }, (_, questionIndex) => ({
          question: `Question ${questionIndex} ${'q'.repeat(3_000)}`,
          header: 'h'.repeat(300),
          options: Array.from({ length: 20 }, (_, optionIndex) => ({
            label: `Option ${optionIndex} ${'o'.repeat(600)}`,
            description: 'd'.repeat(2_000),
          })),
        })),
      },
    })!
    expect(model.questions).toHaveLength(4)
    expect(model.questions[0].options).toHaveLength(20)
    expect(model.questions[0].question.length).toBe(2_000)
    expect(model.questions[0].header?.length).toBe(160)
    expect(model.questions[0].options[0].label.length).toBe(400)
    expect(model.questions[0].options[0].description?.length).toBe(1_000)
    expect(model.questions[0].answerQuestion?.length).toBeGreaterThan(2_000)
    expect(model.questions[0].answerHeader?.length).toBe(300)
    expect(model.questions[0].options[0].answerLabel?.length).toBeGreaterThan(400)
  })
})
