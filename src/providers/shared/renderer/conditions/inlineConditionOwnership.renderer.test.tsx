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

describe('condition strips as a keyboard and screen reader user meets them (ledger N16)', () => {
  // The rows were `div onClick` with a prose footer: nothing announced which
  // choice the agent had highlighted, and the strip could be focused only by
  // its mount effect, so tabbing away from a pending approval lost it for
  // good. Keys are still forwarded to the agent, so these pin the SEMANTICS
  // and reachability, and that the forwarded keys did not change.
  function runFrames() {
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(performance.now())
      return 1
    })
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
  }

  it('lands focus on a Claude resume listbox that names the highlighted choice', () => {
    runFrames()
    const onSend = vi.fn(async () => undefined)
    const { rerender } = render(<ResumePromptModal prompt={{ selectedIndex: 0 }} onSend={onSend} interactionActive />)
    const list = screen.getByRole('listbox', { name: 'Resume choices' })
    expect(document.activeElement).toBe(list)
    expect(list.tabIndex).toBe(0)
    const options = screen.getAllByRole('option')
    expect(options).toHaveLength(3)
    expect(list.getAttribute('aria-activedescendant')).toBe(options[0]!.id)

    // The agent moved its highlight (the parser reports index 1): the
    // pointer follows, still on the focused list.
    rerender(<ResumePromptModal prompt={{ selectedIndex: 1 }} onSend={onSend} interactionActive />)
    expect(list.getAttribute('aria-activedescendant')).toBe(options[1]!.id)
    expect(options[1]).toHaveAttribute('aria-selected', 'true')

    // Keys pressed on the focused list still reach the agent unchanged.
    fireEvent.keyDown(list, { key: 'ArrowDown' })
    expect(onSend).toHaveBeenLastCalledWith('\x1b[B')
    fireEvent.keyDown(list, { key: 'Enter' })
    expect(onSend).toHaveBeenLastCalledWith('\r')
  })

  it('shows Codex s direct keys as chips on the rows they choose', () => {
    runFrames()
    const onSend = vi.fn(async () => undefined)
    render(
      <CodexApprovalModal
        approval={{ callId: 'c1', command: ['git', 'status'], workdir: '/repo' }}
        onSend={onSend}
        interactionActive
      />,
    )
    const list = screen.getByRole('listbox', { name: 'Approval choices' })
    expect(document.activeElement).toBe(list)
    const chips = screen.getAllByRole('option').map(option => option.querySelector('[data-slot="kbd"]')?.textContent)
    expect(chips).toEqual(['Y', 'P', '⎋'])
    // The chip is true: Y on the focused list approves (Enter to the PTY).
    fireEvent.keyDown(list, { key: 'y' })
    expect(onSend).toHaveBeenLastCalledWith('\r')
    expect(document.querySelector('[data-slot="kbd-legend"]')?.textContent).toContain('confirm')
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
