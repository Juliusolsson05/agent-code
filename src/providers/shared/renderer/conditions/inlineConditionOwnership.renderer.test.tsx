import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ResumePromptModal } from '@providers/claude/renderer/ResumePromptModal'
import { CodexApprovalModal } from '@providers/codex/renderer/CodexApprovalModal'

afterEach(() => {
  vi.unstubAllGlobals()
})

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

  it('cancels a pending focus request when Claude pane ownership moves', () => {
    const pending: FrameRequestCallback[] = []
    const cancel = vi.fn()
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
      pending.push(callback)
      return 41
    }))
    vi.stubGlobal('cancelAnimationFrame', cancel)

    const onSend = vi.fn(async () => undefined)
    const { rerender } = render(
      <ResumePromptModal prompt={{ selectedIndex: 0 }} onSend={onSend} interactionActive />,
    )
    const outside = document.createElement('button')
    document.body.append(outside)
    outside.focus()

    rerender(
      <ResumePromptModal
        prompt={{ selectedIndex: 0 }}
        onSend={onSend}
        interactionActive={false}
      />,
    )
    pending[0]?.(performance.now())

    expect(cancel).toHaveBeenCalledWith(41)
    expect(document.activeElement).toBe(outside)
  })

  it('does not reschedule Codex focus for a new wrapper with the same approval identity', () => {
    const request = vi.fn((_callback: FrameRequestCallback) => 7)
    vi.stubGlobal('requestAnimationFrame', request)
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    const onSend = vi.fn(async () => undefined)
    const approval = { callId: 'call-1', command: ['git', 'status'], workdir: '/repo' }
    const { rerender } = render(
      <CodexApprovalModal approval={approval} onSend={onSend} interactionActive />,
    )

    rerender(
      <CodexApprovalModal approval={{ ...approval }} onSend={onSend} interactionActive />,
    )

    expect(request).toHaveBeenCalledOnce()
  })
})

describe('what an approval modal SHOWS is part of the decision (#1049)', () => {
  it('keeps a trailing carriage return visible instead of trimming it away', async () => {
    // `./check.sh\r` is a filename whose last byte is CR: a shell runs a
    // DIFFERENT file than `./check.sh`, and the two render identically. The
    // first fix escaped the command but trimmed it first, and `.trim()`
    // removes CR — so the modal went on showing the safe-looking name for the
    // command Codex would actually run (#1049 re-review).
    const { CodexApprovalModal } = await import('@providers/codex/renderer/CodexApprovalModal')
    render(
      <CodexApprovalModal
        approval={{ callId: 'call-cr', command: ['./check.sh\r'], workdir: '/repo' }}
        onSend={vi.fn(async () => undefined)}
        interactionActive={false}
      />,
    )
    const strip = screen.getByRole('group', { name: 'Codex command approval options' })
    expect(strip.textContent).toContain('U+000D CR')
  })
})
