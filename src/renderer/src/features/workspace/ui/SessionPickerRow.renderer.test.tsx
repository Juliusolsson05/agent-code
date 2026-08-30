import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { SessionPickerRow } from '@renderer/features/workspace/ui/SessionPickerRow'
import type { SessionDisplayIdentity } from '@shared/types/sessionDisplayIdentity'

// Regression coverage for the display half of #96.
//
// WHY these assert the FALLBACK MARKING rather than the label text: rendering
// `identity.label` is trivial and cannot regress meaningfully. What can regress
// — and what the old surfaces got wrong — is presenting a stand-in as if it
// were a name. A row that shows the folder `agent-code` identically to a
// user-chosen title "agent-code" is the defect, and only `labelSource` can tell
// them apart. If a future refactor drops that distinction the rows still look
// plausible, so a human reviewer would not catch it; these tests would.

function identity(over: Partial<SessionDisplayIdentity> = {}): SessionDisplayIdentity {
  return {
    providerSessionId: '8d6926a5-1111-2222',
    kind: 'claude',
    cwd: '/Users/dev/projects/agent-code',
    label: 'design the ownership ledger',
    labelSource: 'first-prompt',
    lastActivityAt: Date.now(),
    gitBranch: null,
    ...over,
  }
}

describe('SessionPickerRow (#96)', () => {
  it('renders a real label plainly, without fallback styling', () => {
    render(<SessionPickerRow identity={identity()} />)
    const label = screen.getByText('design the ownership ledger')
    expect(label.className).not.toContain('italic')
  })

  it('marks a cwd fallback so it does not read as a chosen name', () => {
    render(
      <SessionPickerRow identity={identity({ label: 'agent-code', labelSource: 'cwd' })} />,
    )
    const label = screen.getByText('agent-code')
    expect(label.className).toContain('italic')
    // Said out loud too — italics alone are invisible to a screen reader, and
    // "is this actually the conversation's name?" is the question the row
    // exists to answer.
    expect(label.title).toMatch(/no title recorded/i)
  })

  it('marks a session-id fallback the same way', () => {
    render(
      <SessionPickerRow
        identity={identity({ label: '8d6926a5', labelSource: 'session-id', cwd: null })}
      />,
    )
    const label = screen.getByText('8d6926a5')
    expect(label.className).toContain('italic')
    expect(label.title).toMatch(/session id/i)
  })

  it('does not repeat the project folder when the folder IS the label', () => {
    // Guards a specific ugly output: label "agent-code" (cwd fallback) with
    // "agent-code" again on the metadata line, which reads as a duplicate-render
    // bug rather than as context.
    render(
      <SessionPickerRow identity={identity({ label: 'agent-code', labelSource: 'cwd' })} />,
    )
    expect(screen.getAllByText('agent-code')).toHaveLength(1)
  })

  it('shows the project alongside a real label', () => {
    render(<SessionPickerRow identity={identity()} />)
    expect(screen.getByText('agent-code')).toBeInTheDocument()
  })
})
