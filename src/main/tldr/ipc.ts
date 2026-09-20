import { ipcMain, systemPreferences } from 'electron'
import { z } from 'zod'
import { validTldrIdentity } from '@shared/types/tldr.js'
import type { HoldEndReason, TldrUpdate } from '@shared/types/tldr.js'
import type { TldrStore } from './TldrStore.js'
import type { TldrEnforcement } from './enforcement.js'
import { broadcastToWindows, getBrowserWindow, windowIdFor } from '@main/window/windowRegistry.js'
import { ensureMacHotkeyHelperBinary } from '@main/dictation/macHotkeyHelper.js'
import { watchMacTldrRelease } from './holdRelease.js'
import type { AppRunJournal } from '@main/incident/AppRunJournal.js'

function assertApplicationWindow(event: Electron.IpcMainInvokeEvent): void {
  const windowId = windowIdFor(event.sender)
  if (!windowId || !getBrowserWindow(windowId) || event.senderFrame !== event.sender.mainFrame) {
    throw new Error('TLDR requires a registered application window.')
  }
}

const identityList = z.array(z.string().refine(validTldrIdentity)).max(10_000)
const singleIdentity = z.string().refine(validTldrIdentity)

/**
 * Record an unobservable hold ONCE per app run.
 *
 * WHY once: the cause is a machine-wide permission state, not a per-gesture
 * fault, so every subsequent peek would report the identical thing. The
 * dictation hotkey's `dictation.hotkey.unavailable` breadcrumb set this
 * precedent, and it is what made #1066 diagnosable at all — the peek's silence
 * is exactly what left the user with no way to tell a missing permission from
 * a broken feature.
 */
let reportedUnobservableHold = false

/**
 * Is the probe's verdict corroborated by the system itself?
 *
 * WHY this second opinion exists (review findings 5 and 6). The helper infers
 * blindness from Command reading as up, and that inference has two failure
 * modes:
 *
 *  - A tap faster than the ~20 ms spawn releases Command before the first
 *    poll, so a healthy Mac reports 67. Without this check that writes a false
 *    "grant Accessibility" into the debug bundle and, being once-per-run,
 *    silences the real report for the rest of the session.
 *  - If `keyState` ever blinds non-uniformly — modifiers readable, letters not
 *    — the probe exits 0 and the real fault goes unrecorded.
 *
 * `isTrustedAccessibilityClient(false)` answers the actual question and
 * PROMPTS NOTHING, which matters because a read-only pane preview must never
 * raise a permission dialog. It is the reason the message can name
 * Accessibility at all: with it, that is observed rather than guessed.
 */
function accessibilityDenied(): boolean {
  if (process.platform !== 'darwin') return false
  try {
    return !systemPreferences.isTrustedAccessibilityClient(false)
  } catch {
    // An Electron without the API tells us nothing; say nothing rather than
    // blame a permission we did not check.
    return false
  }
}

function noteHoldUnobservable(journal: AppRunJournal | null): void {
  if (reportedUnobservableHold || !journal) return
  reportedUnobservableHold = true
  // The APP-RUN JOURNAL, not performanceService: the journal is what lands in
  // a debug bundle and is exactly where #1066's diagnosis eventually came
  // from — the dictation breadcrumb sitting in `incidents/runs/*/events.jsonl`.
  // Severity 'warn', not 'error': the app is fine, one affordance degraded.
  journal.record({
    area: 'app.tldr',
    name: 'tldr.hold.unobservable',
    severity: 'warn',
    data: {
      message: 'the hold-to-peek release watcher cannot observe the keyboard, so '
        + 'the peek follows the Command key instead of the letter — grant Agent '
        + 'Code Accessibility permission in System Settings → Privacy & Security '
        + '→ Accessibility. A newly signed build starts without the grants the '
        + 'previous one had, because macOS keys them to the code signature.',
    },
  })
}

export function registerTldrIpc(
  store: TldrStore,
  enforcement: Pick<TldrEnforcement, 'status'>,
  // Optional so the many tests that register this IPC keep compiling; main
  // always passes it. A missing journal loses a breadcrumb, never behaviour.
  appRunJournal: AppRunJournal | null = null,
): void {
  // Warm the development build without delaying the first peek. This only
  // resolves/builds our bundled executable; it starts no keyboard observer.
  const helper = process.platform === 'darwin' ? ensureMacHotkeyHelperBinary() : null
  void helper?.catch(() => {})
  const holds = new Map<number, { token: string; cancel: () => void }>()
  const holdRequest = z.object({ code: z.string().max(32), token: z.string().uuid() })
  ipcMain.on('tldr:hold-start', (event, raw: unknown) => {
    const windowId = windowIdFor(event.sender)
    const window = windowId ? getBrowserWindow(windowId) : null
    if (!helper || !window?.isFocused() || event.senderFrame !== event.sender.mainFrame) return
    const parsed = holdRequest.safeParse(raw)
    if (!parsed.success) return
    const { code, token } = parsed.data
    const senderId = event.sender.id
    holds.get(senderId)?.cancel()
    const finish = (reason: HoldEndReason = 'released') => {
      if (holds.get(senderId)?.token !== token) return
      holds.get(senderId)?.cancel()
      // Only claim blindness when the system agrees. An uncorroborated 67 is
      // most likely a tap faster than the helper's own spawn, and that must
      // behave as an ordinary release rather than accuse a permission.
      const blind = reason === 'unobservable' && accessibilityDenied()
      if (blind) noteHoldUnobservable(appRunJournal)
      if (!event.sender.isDestroyed()) {
        // The renderer is told WHICH it was so it can explain itself instead of
        // flashing (#1066). It never learns the exit code; main translates.
        event.sender.send('tldr:hold-released', token, blind ? 'unobservable' : 'released')
      }
    }
    // Declared before `cancel` references it: these three end the hold for
    // reasons that say nothing about the keyboard, so they take the default
    // 'released'. Passing `finish` directly would hand Electron's event object
    // in as `reason`.
    const finishNormally = () => finish()
    const stop = watchMacTldrRelease(helper, code, finish)
    const cancel = () => {
      stop()
      window.removeListener('blur', finishNormally)
      window.removeListener('closed', finishNormally)
      event.sender.removeListener('did-start-navigation', finishNormally)
      if (holds.get(senderId)?.token === token) holds.delete(senderId)
    }
    holds.set(senderId, { token, cancel })
    window.once('blur', finishNormally)
    window.once('closed', finishNormally)
    event.sender.once('did-start-navigation', finishNormally)
  })
  ipcMain.on('tldr:hold-stop', (event, token: unknown) => {
    const hold = holds.get(event.sender.id)
    if (hold && hold.token === token) hold.cancel()
  })
  const identities = identityList
  const identity = singleIdentity
  ipcMain.handle('tldr:read', (event, raw: unknown) => {
    assertApplicationWindow(event)
    return store.read(identities.parse(raw))
  })
  ipcMain.handle('tldr:history', (event, raw: unknown) => {
    assertApplicationWindow(event)
    return store.history(identity.parse(raw))
  })
  // Read-only, like every renderer TLDR API: whether this identity's provider
  // hooks have reached main. The renderer uses it to say when enforcement is not
  // running; it can never mark a hook as having fired.
  ipcMain.handle('tldr:enforcement', (event, raw: unknown) => {
    assertApplicationWindow(event)
    return enforcement.status(identities.parse(raw))
  })
  // Renderer APIs are read-only. Only the authenticated MCP scope can write;
  // neither a model-supplied target ID nor a UI convenience method bypasses it.
  store.on('changed', (update: TldrUpdate) => broadcastToWindows('tldr:changed', update))
}

/**
 * Read-only renderer access to goals (#936), mirroring TLDR's read surface.
 * Goals are written only by the authenticated `goal_set` MCP scope; the hold
 * gesture is shared with TLDR and registered once in registerTldrIpc.
 */
export function registerGoalIpc(store: TldrStore): void {
  ipcMain.handle('goal:read', (event, raw: unknown) => {
    assertApplicationWindow(event)
    return store.read(identityList.parse(raw))
  })
  ipcMain.handle('goal:history', (event, raw: unknown) => {
    assertApplicationWindow(event)
    return store.history(singleIdentity.parse(raw))
  })
  store.on('changed', (update: TldrUpdate) => broadcastToWindows('goal:changed', update))
}
