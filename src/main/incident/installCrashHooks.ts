import type { AppRunJournal } from '@main/incident/AppRunJournal.js'

// Process-level crash hooks for the Electron MAIN process.
//
// WHY this is separate from the window hooks and from the journal itself:
// crash hooks are easy to get subtly wrong (recursion if recording the crash
// throws, async work that never drains before exit, swallowing a fatal that
// should kill the process). Isolating them keeps that danger reviewable, and
// keeps AppRunJournal a pure writer with no opinions about process lifecycle.
//
// These complement — they do not replace — electron's crashReporter/Crashpad
// (started in index.ts). Crashpad catches NATIVE death (V8 aborts, SIGSEGV in a
// native addon) that never reaches JS; these JS hooks catch the JS-level faults
// (uncaught exceptions, unhandled rejections, process warnings) that Crashpad
// can't see. You need both.

export type CrashHookOptions = {
  journal: AppRunJournal
  // Synchronous lock release. A fatal uncaughtException exits the process
  // immediately, bypassing the normal before-quit/will-quit handlers that
  // release the state-process lock — so without this, a main crash would strand
  // the lock and block the NEXT launch (acquireStateProcessLock sees a live
  // pid). The journal does not own the lock, so the owner injects the release.
  releaseLockSync: () => void
}

// Distinct unhandled-rejection messages we will journal before we stop, so a
// rejection loop (same error thrown thousands of times) can't flood the disk.
const MAX_DISTINCT_REJECTIONS = 50

export function installProcessCrashHooks({ journal, releaseLockSync }: CrashHookOptions): void {
  let handlingFatal = false

  process.on('uncaughtException', (error) => {
    // Recursion guard: if recording the crash itself throws (e.g. disk full),
    // do not re-enter — just release the lock and die.
    if (handlingFatal) {
      try { releaseLockSync() } catch { /* already dying */ }
      process.exit(1)
      return
    }
    handlingFatal = true
    // An uncaught exception leaves main in an undefined state; continuing is
    // more dangerous than exiting. recordIncident() writes synchronously AND
    // flushes the pending event breadcrumbs first, so the timeline survives.
    // We deliberately do NOT mark a clean shutdown (this run WAS unclean — a
    // future prior-run classifier must see it that way), but we DO release the
    // lock so the relaunch isn't blocked.
    try {
      journal.recordIncident({
        kind: 'main.uncaught_exception',
        severity: 'fatal',
        process: 'main',
        error,
      })
    } catch { /* best-effort: we're already crashing */ }
    try { releaseLockSync() } catch { /* best-effort */ }
    process.exit(1)
  })

  // Unhandled rejections are non-fatal (Node keeps running), but a hot loop can
  // emit the same one thousands of times. Coalesce by message: journal the
  // first occurrence of each distinct rejection, and cap distinct keys so the
  // map can't grow without bound.
  const journaledRejections = new Set<string>()
  process.on('unhandledRejection', (reason) => {
    const key = reason instanceof Error ? reason.message : String(reason)
    if (journaledRejections.has(key)) return
    if (journaledRejections.size >= MAX_DISTINCT_REJECTIONS) return
    journaledRejections.add(key)
    journal.recordIncident({
      kind: 'main.unhandled_rejection',
      severity: 'error',
      process: 'main',
      error: reason,
    })
  })

  // process warnings (deprecations, MaxListenersExceeded, etc.) are low-severity
  // but occasionally the first sign of a leak. Coalesce exactly like rejections:
  // recordIncident() is SYNCHRONOUS (flushSync + appendFileSync), so an uncapped
  // warning storm (a repeating MaxListenersExceededWarning, say) would drive one
  // blocking disk write per warning on the main thread — the journal adding the
  // very pressure it exists to observe. Journal the first occurrence of each
  // distinct name+message, capped.
  const journaledWarnings = new Set<string>()
  process.on('warning', (warning) => {
    const key = `${warning.name}: ${warning.message}`
    if (journaledWarnings.has(key)) return
    if (journaledWarnings.size >= MAX_DISTINCT_REJECTIONS) return
    journaledWarnings.add(key)
    journal.recordIncident({
      kind: 'main.warning',
      severity: 'warn',
      process: 'main',
      error: warning,
    })
  })
}
