import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { ResumePromptModal } from '@providers/claude/renderer/ResumePromptModal'
import { CodexApprovalModal } from '@providers/codex/renderer/CodexApprovalModal'

describe('pane-local condition keyboard ownership', () => {
  it('does not let a background Claude resume strip consume Enter', () => {
    const onSend = vi.fn(async () => undefined)
    const { rerender } = render(
      <ResumePromptModal
        prompt={{ selectedIndex: 0 }}
        onSend={onSend}
        interactionActive={false}
      />,
    )
    const strip = screen.getByRole('group', { name: 'Resume session options' })

    fireEvent.keyDown(strip, { key: 'Enter' })
    expect(onSend).not.toHaveBeenCalled()

    rerender(
      <ResumePromptModal
        prompt={{ selectedIndex: 0 }}
        onSend={onSend}
        interactionActive
      />,
    )
    fireEvent.keyDown(strip, { key: 'Enter' })
    expect(onSend).toHaveBeenCalledWith('\r')
  })

  it('does not let a background Codex approval consume shortcut keys', () => {
    const onSend = vi.fn(async () => undefined)
    const approval = {
      callId: 'call-1',
      command: ['git', 'status'],
      workdir: '/repo',
    }
    const { rerender } = render(
      <CodexApprovalModal
        approval={approval}
        onSend={onSend}
        interactionActive={false}
      />,
    )
    const strip = screen.getByRole('group', { name: 'Codex command approval options' })

    fireEvent.keyDown(strip, { key: 'n' })
    expect(onSend).not.toHaveBeenCalled()

    rerender(
      <CodexApprovalModal approval={approval} onSend={onSend} interactionActive />,
    )
    fireEvent.keyDown(strip, { key: 'n' })
    expect(onSend).toHaveBeenCalledWith('\x1b')
  })
})
