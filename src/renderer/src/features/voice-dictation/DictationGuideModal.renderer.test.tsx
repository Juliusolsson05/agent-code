import { act, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { DictationGuideModal } from './DictationGuideModal'

describe('DictationGuideModal interaction boundary', () => {
  it('publishes the explicit ownership marker consumed by the UI rewrite', () => {
    render(<DictationGuideModal />)

    act(() => {
      window.dispatchEvent(new CustomEvent('agent-code:open-dictation-guide'))
    })

    // WHY use the DOM API directly: this repository deliberately does not
    // install jest-dom's matcher augmentation. Pulling that dependency into the
    // production typecheck for one assertion would make this otherwise small
    // interaction-boundary regression test define the test-stack policy.
    expect(
      screen
        .getByRole('dialog', { name: 'Configure Voice Dictation' })
        .getAttribute('data-agent-code-interaction-owner'),
    ).toBe('app')
  })
})
