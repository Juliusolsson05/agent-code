import { ScreenTailHistory } from '@shared/debug/screenTail.js'

// Which sessions a renderer currently wants live `session:screen` frames for.
//
// WHY frames are opt-in (#762): `session:screen` carried 93% of recorded IPC
// bytes (16,728 frames x 8.8 KB in one 123-minute recording) and arrived 6-10
// times a second per busy session, every one structured-cloned, dispatched and
// committed into the renderer's runtime map. A map of every consumer found that
// nothing live needs them:
//   - main already reads the screen itself for prompt delivery, paste
//     confirmation and readiness (`session.snapshotScreen()`);
//   - the composer's slash picker is owned by the conditions channel
//     (`claude.slash-picker`, applyConditionSnapshot);
//   - the Enter-baseline `latestScreenRef` and the renderer paste helpers
//     were dead code;
//   - ReaderView no longer has a screen fallback (#855).
// What remains are debug surfaces (DebugPanel, the dev modules), which take a
// lease while they are open, and debug bundles, which ask main directly
// (`session:get-screen-debug`) and read the screen-tail history recorded here.
//
// WHY leases are owned by a webContents and not just counted: a renderer that
// reloads or crashes never runs its cleanup, and a bare counter would then
// forward that session's frames forever. Dropping an owner's leases when its
// webContents is destroyed, or when a NEW document in it starts taking leases,
// keeps the count honest. (A leaked lease would only cost bytes, never
// correctness, but the whole point here is the bytes.)
//
// WHY a document id and not a navigation event (#1236 review): the app window
// blocks every main-frame `will-navigate` (appWindow.ts), and Chromium reports
// `did-start-navigation` BEFORE the throttle that emits and blocks
// `will-navigate`. Dropping on navigation start therefore also dropped every
// lease when a stray link click was blocked and the page never changed, so an
// open debug panel silently went stale. The preload mints one id per loaded
// document and sends it with every lease; a lease from a different id proves
// the old document is gone, whatever event order Electron uses. The cost: after
// a reload, the dead document's leases survive until the new one takes its
// first lease or the window closes, which is debug-surface bytes only.

export class ScreenInterest {
  private readonly byOwner = new Map<number, Map<string, number>>()
  private readonly totals = new Map<string, number>()
  private readonly documents = new Map<number, string>()

  acquire(owner: number, sessionId: string, document: string): void {
    const current = this.documents.get(owner)
    if (current !== undefined && current !== document) this.dropOwner(owner)
    this.documents.set(owner, document)
    let leases = this.byOwner.get(owner)
    if (!leases) {
      leases = new Map()
      this.byOwner.set(owner, leases)
    }
    leases.set(sessionId, (leases.get(sessionId) ?? 0) + 1)
    this.totals.set(sessionId, (this.totals.get(sessionId) ?? 0) + 1)
  }

  release(owner: number, sessionId: string, document: string): void {
    // A release from a document that no longer owns the leases has nothing
    // of its own to release.
    if (this.documents.get(owner) !== document) return
    const leases = this.byOwner.get(owner)
    const held = leases?.get(sessionId) ?? 0
    // A release the owner does not hold (double release, or one that raced
    // dropOwner) must not decrement someone else's lease.
    if (!leases || held <= 0) return
    if (held === 1) leases.delete(sessionId)
    else leases.set(sessionId, held - 1)
    if (leases.size === 0) this.byOwner.delete(owner)
    this.decrementTotal(sessionId, 1)
  }

  dropOwner(owner: number): void {
    this.documents.delete(owner)
    const leases = this.byOwner.get(owner)
    if (!leases) return
    this.byOwner.delete(owner)
    for (const [sessionId, held] of leases) this.decrementTotal(sessionId, held)
  }

  wants(sessionId: string): boolean {
    return (this.totals.get(sessionId) ?? 0) > 0
  }

  private decrementTotal(sessionId: string, by: number): void {
    const next = (this.totals.get(sessionId) ?? 0) - by
    if (next > 0) this.totals.set(sessionId, next)
    else this.totals.delete(sessionId)
  }
}

/** The process-wide instances: the forwarder consults and feeds them, the
 *  session IPC handlers mutate and read them. Module singletons for the same
 *  reason windowRegistry is one: both sides are wired in different files and
 *  there is exactly one main process. */
export const screenInterest = new ScreenInterest()
export const screenTailHistory = new ScreenTailHistory()
