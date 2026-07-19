import { describe, expect, it } from 'vitest'

import {
  coerceSavedPromptTemplates,
  syncTemplateVariablesFromBody,
} from '@renderer/features/prompt-templates/savedPromptTemplates'

describe('coerceSavedPromptTemplates', () => {
  it('migrates legacy saved templates into the managed shape', () => {
    expect(coerceSavedPromptTemplates([
      {
        id: 'custom:1',
        title: 'Bug Repro',
        body: 'Goal: {{goal}}',
        createdAt: 1,
        updatedAt: 2,
      },
    ])).toEqual([
      {
        id: 'custom:1',
        title: 'Bug Repro',
        description: 'Saved locally',
        body: 'Goal: {{goal}}',
        scope: 'custom',
        insertMode: 'replace',
        variables: [
          {
            name: 'goal',
            label: 'Goal',
            description: '',
            defaultValue: '',
            required: false,
          },
        ],
        createdAt: 1,
        updatedAt: 2,
      },
    ])
  })

  it('drops malformed entries and duplicate ids', () => {
    expect(coerceSavedPromptTemplates([
      null,
      { id: 'custom:1', title: 'Good', body: 'Hi' },
      { id: 'custom:1', title: 'Duplicate', body: 'Ignored' },
      { id: 7, title: 'Bad', body: 'Ignored' },
    ])).toHaveLength(1)
  })
})

describe('syncTemplateVariablesFromBody', () => {
  it('preserves metadata for retained placeholders and adds new ones', () => {
    expect(syncTemplateVariablesFromBody(
      'Goal: {{goal}}\nBranch: {{branch}}',
      [
        {
          name: 'goal',
          label: 'Primary Goal',
          description: 'What to accomplish',
          defaultValue: 'Ship it',
          required: true,
        },
      ],
    )).toEqual([
      {
        name: 'goal',
        label: 'Primary Goal',
        description: 'What to accomplish',
        defaultValue: 'Ship it',
        required: true,
      },
      {
        name: 'branch',
        label: 'Branch',
        description: '',
        defaultValue: '',
        required: false,
      },
    ])
  })
})
