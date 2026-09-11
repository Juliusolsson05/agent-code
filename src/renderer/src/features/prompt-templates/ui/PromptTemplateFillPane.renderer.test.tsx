import { render, screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'

import { PromptTemplateFillPane } from './PromptTemplateFillPane'
import type { PromptTemplate } from '@renderer/features/prompt-templates/types'

const template = {
  id: 'custom:1', title: 'Review', description: '', body: 'Review {{scope}}',
  scope: 'custom', insertMode: 'replace',
  variables: [{ name: 'scope', label: 'Scope', description: '', defaultValue: '', required: false }],
} as unknown as PromptTemplate

function pane(deliverySurface: 'composer' | 'pty') {
  return render(
    <PromptTemplateFillPane template={template} values={{}} insertMode="replace" deliverySurface={deliverySurface}
      onValueChange={vi.fn()} onInsertModeChange={vi.fn()} onCancel={vi.fn()} onInsert={vi.fn()} />,
  )
}

it('offers replace/append only where a draft exists, and says what a terminal does instead (#865)', () => {
  // On a PTY "replace" silently meant "paste at the cursor"; the pane claimed
  // it replaced the draft. Say the truth rather than offer a false choice.
  pane('pty')
  expect(screen.queryByRole('radio')).toBeNull()
  expect(screen.getByText(/Pastes at the terminal cursor/)).toBeTruthy()
})

it('keeps the insert-mode choice for a composer target', () => {
  pane('composer')
  expect(screen.getAllByRole('radio')).toHaveLength(2)
})
