import { describe, expect, it } from 'vitest'

import { promptTemplateFillReturnState } from '@renderer/features/command-palette/lib/promptTemplateFillReturn'

describe('promptTemplateFillReturnState', () => {
  it('restores the exact mixed command search after fill cancellation', () => {
    expect(promptTemplateFillReturnState('commands', 'review changes', 3)).toEqual({
      mode: 'commands',
      query: 'review changes',
      selectedIndex: 3,
    })
  })

  it('preserves the dedicated picker cancellation behavior', () => {
    expect(promptTemplateFillReturnState('prompt-template', 'review', 2)).toEqual({
      mode: 'prompt-template',
      query: '',
      selectedIndex: 0,
    })
    expect(promptTemplateFillReturnState('manage-prompt-template', 'review', 2)).toEqual({
      mode: 'prompt-template',
      query: '',
      selectedIndex: 0,
    })
  })
})
