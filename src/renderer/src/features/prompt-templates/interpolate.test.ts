import { describe, expect, it } from 'vitest'

import {
  applyPromptTemplateInsertMode,
  collectPromptTemplatePlaceholders,
  fillPromptTemplateBody,
} from '@renderer/features/prompt-templates/interpolate'

describe('collectPromptTemplatePlaceholders', () => {
  it('returns unique placeholders in first-seen order', () => {
    expect(
      collectPromptTemplatePlaceholders(
        'Goal: {{goal}}\nBranch: {{branch_name}}\nRepeat: {{goal}}',
      ),
    ).toEqual(['goal', 'branch_name'])
  })
})

describe('fillPromptTemplateBody', () => {
  it('fills prompt templates from explicit values and defaults', () => {
    expect(fillPromptTemplateBody({
      body: 'Goal: {{goal}}\nBranch: {{branch}}\nNotes: {{notes}}',
      variables: [
        { name: 'goal', label: 'Goal', description: '', defaultValue: '', required: true },
        { name: 'branch', label: 'Branch', description: '', defaultValue: 'main', required: true },
        { name: 'notes', label: 'Notes', description: '', defaultValue: 'n/a', required: false },
      ],
      values: {
        goal: 'Fix the crash',
      },
    })).toBe('Goal: Fix the crash\nBranch: main\nNotes: n/a')
  })

  it('throws when required variables are unresolved', () => {
    expect(() =>
      fillPromptTemplateBody({
        body: 'Goal: {{goal}}\nBranch: {{branch}}',
        variables: [
          { name: 'goal', label: 'Goal', description: '', defaultValue: '', required: true },
          { name: 'branch', label: 'Branch', description: '', defaultValue: '', required: true },
        ],
        values: { goal: 'Reproduce bug' },
      })).toThrow('Missing required template values: branch')
  })
})

describe('applyPromptTemplateInsertMode', () => {
  it('replaces the draft when replace mode is selected', () => {
    expect(applyPromptTemplateInsertMode('Existing draft', 'Inserted body', 'replace')).toBe('Inserted body')
  })

  it('appends below the draft with one blank line', () => {
    expect(applyPromptTemplateInsertMode('Existing draft', 'Inserted body', 'append')).toBe(
      'Existing draft\n\nInserted body',
    )
  })
})
