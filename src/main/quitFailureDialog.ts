/**
 * What the user is told, and what they can DO, when a committed quit could not
 * finish (#945 Codex review).
 *
 * WHY this is its own module rather than a closure in index.ts: by the time
 * this runs, `will-quit` has been admitted and every window is gone. The only
 * remaining way to reach the application is this dialog's buttons, so which
 * buttons exist — and whether their answer is acted on — is load-bearing
 * behavior, not presentation. index.ts cannot be imported by a test (it builds
 * the whole application on import), so the decision lives here where it can be
 * driven directly.
 *
 * WHAT WAS WRONG: the dialog said "Quit again to retry" while offering exactly
 * one button, "Keep Agent Code Open", and discarded the response. On macOS a
 * user can quit again from the Dock; on Windows and Linux the menu bar belongs
 * to a window, window creation is fenced after commitment, and `focusWindow`
 * has nothing to focus. So a transient stop failure — a workflow provider that
 * needed one more moment — stranded the process and its state lock with no
 * reachable action, even though a second attempt would have succeeded.
 *
 * The retry is safe by construction: `applicationShutdown` drops FAILED stages
 * at the start of the next drain and keeps completed ones, so quitting again
 * re-runs only what did not finish.
 */

/** The parts of Electron's `dialog` and `app` this needs, so a test supplies
 *  plain objects instead of booting Electron. */
export type QuitFailureDialogHost = {
  showMessageBox(options: {
    type: 'error'
    title: string
    message: string
    detail: string
    buttons: string[]
    defaultId: number
    cancelId: number
    noLink: boolean
  }): Promise<{ response: number }>
}
export type QuitFailureApp = { quit(): void }

export function quitFailureDetail(error: unknown): string {
  const causes = error instanceof AggregateError
    ? error.errors.map(cause => (cause instanceof Error ? cause.message : String(cause))).join('\n')
    : error instanceof Error
      ? error.message
      : String(error)
  return `Shutdown is incomplete. Retry when you are ready; anything that already stopped stays stopped.\n\n${causes}`
}

/**
 * Shows the failure and acts on the answer. Resolves once the user has
 * answered (or immediately if the dialog itself fails), so callers can await
 * it in tests; production calls it fire-and-forget.
 */
export async function presentQuitFailure(
  host: QuitFailureDialogHost,
  app: QuitFailureApp,
  error: unknown,
): Promise<void> {
  try {
    const { response } = await host.showMessageBox({
      type: 'error',
      title: 'Agent work is still shutting down',
      message: 'Agent Code could not safely quit yet.',
      detail: quitFailureDetail(error),
      // Retry first and as the default: the common case is a provider that
      // needed another moment, and pressing Return should try again rather
      // than park an application the user has already asked to close.
      buttons: ['Retry Quit', 'Keep Agent Code Open'],
      defaultId: 0,
      // Escape means "not now", never "try again": a retry can kill sessions.
      cancelId: 1,
      noLink: true,
    })
    if (response === 0) app.quit()
  } catch (dialogError) {
    console.error('[app] could not show shutdown error:', dialogError)
  }
}
