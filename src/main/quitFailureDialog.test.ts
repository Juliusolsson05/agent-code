import { describe, expect, it, vi } from 'vitest'

import { presentQuitFailure, quitFailureDetail, type QuitFailureDialogHost } from './quitFailureDialog'

// #945 Codex review: when a committed quit fails, `will-quit` has already been
// admitted and every window is gone. This dialog is the only control the
// application still has, so its buttons — and whether the answer is acted on —
// decide whether a transient stop failure strands the process and its state
// lock. The earlier version said "Quit again to retry" while offering only
// "Keep Agent Code Open" and discarding the response; on Windows and Linux the
// menu bar belongs to a window and window creation is fenced after
// commitment, so there was nothing left to quit with.

type Options = Parameters<QuitFailureDialogHost['showMessageBox']>[0]

function host(response: number) {
  return { showMessageBox: vi.fn(async (_options: Options) => ({ response })) }
}

describe('a failed committed quit', () => {
  it('offers a retry that actually re-quits, with retry as the default button', async () => {
    const dialog = host(0)
    const app = { quit: vi.fn() }
    await presentQuitFailure(dialog, app, new Error('workflow stop timed out'))
    const options = dialog.showMessageBox.mock.calls[0]![0]
    expect(options.buttons).toEqual(['Retry Quit', 'Keep Agent Code Open'])
    expect(options.defaultId).toBe(0)
    expect(app.quit).toHaveBeenCalledOnce()
  })

  it('does nothing when the user chooses to wait, and Escape means wait', async () => {
    const dialog = host(1)
    const app = { quit: vi.fn() }
    await presentQuitFailure(dialog, app, new Error('workflow stop timed out'))
    // Escape must never re-enter a quit that can kill live sessions.
    expect(dialog.showMessageBox.mock.calls[0]![0].cancelId).toBe(1)
    expect(app.quit).not.toHaveBeenCalled()
  })

  it('reports every cause of an aggregate failure, since one stage can fail per owner', () => {
    const detail = quitFailureDetail(new AggregateError([new Error('workflows: timed out'), new Error('sessions: EBUSY')]))
    expect(detail).toContain('workflows: timed out')
    expect(detail).toContain('sessions: EBUSY')
  })

  it('never lets a failing dialog throw into the shutdown path', async () => {
    const dialog = { showMessageBox: vi.fn(async (_options: Options) => { throw new Error('no display') }) }
    const app = { quit: vi.fn() }
    await expect(presentQuitFailure(dialog, app, new Error('boom'))).resolves.toBeUndefined()
    expect(app.quit).not.toHaveBeenCalled()
  })
})
