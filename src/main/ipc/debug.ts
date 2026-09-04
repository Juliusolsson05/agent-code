import { ipcMain } from 'electron'

import { queueFeedDebugAppend } from '@main/storage/feedDebugLog.js'
import type { FeedDebugPersistEntry } from '@main/storage/feedDebugLog.js'
import { saveDebugBundle } from '@main/storage/debugBundle.js'
import type { SaveDebugBundleParams, SaveDebugBundleResult } from '@main/storage/debugBundle.js'
import {
  addDebugBundleNote,
  isAutosaveDebugBundleReason,
} from '@main/storage/debugBundleLog.js'
import { readProxyEventsForBundle } from '@main/storage/proxyEventsReader.js'
import type { ProxyEventsBundleSection } from '@main/storage/proxyEventsReader.js'
import type { AppRunJournal } from '@main/incident/AppRunJournal.js'
import type { LifecycleIpcDiagnostics } from '@main/ipc/lifecycle.js'

// Debug-panel IPC.
//
// Two endpoints:
//   - debug:append-feed-log — paced batches from the renderer's
//     persistence hook (useFeedDebugPersist, #748). Serialized per-session
//     in the storage module; this handler just validates shape and forwards.
//   - debug:save-bundle — one-shot, user-triggered from the "Save
//     Debug Logs" command palette entry. Renderer assembles the bundle
//     (state + feed-debug + proxy semantic + html raw/clean) and we
//     persist it as a timestamped folder. Main chooses the manual vs.
//     autosave root from params.reason so renderer callers cannot
//     accidentally make the "Save Debug Logs" history noisy again.
//     The return value is the absolute path so the renderer can
//     display it and copy it to the clipboard.

export function registerDebugIpc(
  journal: AppRunJournal,
  lifecycleDiagnostics: LifecycleIpcDiagnostics,
): void {
  ipcMain.handle(
    'debug:append-feed-log',
    async (
      _evt,
      params: { sessionId: string; entries: FeedDebugPersistEntry[] },
    ) => {
      if (!params?.sessionId || !Array.isArray(params.entries) || params.entries.length === 0) {
        return
      }
      await queueFeedDebugAppend(params.sessionId, params.entries)
    },
  )

  ipcMain.handle(
    'debug:save-bundle',
    async (_evt, params: SaveDebugBundleParams): Promise<SaveDebugBundleResult> => {
      let journalFlushFailed = false
      // Lifecycle reports arrive over fire-and-forget IPC and AppRunJournal
      // batches them for up to one second. A manual bundle is often captured
      // immediately after the bad paint; without this drain, the named
      // observation stream would deterministically omit the newest decision
      // chain even though the user clicked Save after seeing it. Flush before
      // reading the journal, but keep it best-effort: forensic enrichment must
      // never make the renderer-owned bundle unsaveable on a degraded disk.
      if (!isAutosaveDebugBundleReason(params.reason)) {
        try {
          journalFlushFailed = !(await journal.flush())
        } catch (err) {
          // flush normally converts a write failure to `false` after safely
          // re-queueing its batch. Keep this catch as a last-resort boundary for
          // unexpected journal bugs: the core renderer bundle is still useful,
          // but its manifest must not call the source observation chain whole.
          journalFlushFailed = true
          console.warn('[debug-bundle] failed to flush incident journal before save', err)
        }
      }
      // Let errors propagate. The renderer catches and shows a
      // `save failed: <msg>` toast — the user triggered this
      // explicitly, so silent failure is strictly worse than a
      // surfaced one.
      return saveDebugBundle(params, isAutosaveDebugBundleReason(params.reason)
        ? undefined
        : {
            appRunJournalCompleteness: {
              ...journal.getCompletenessSnapshot(),
              flushFailed: journalFlushFailed,
            },
            codexTranscriptObservationCompleteness:
              lifecycleDiagnostics.getCodexTranscriptObservationCompletenessSnapshot(),
          })
    },
  )

  ipcMain.handle(
    'debug:add-bundle-note',
    async (_evt, params: { bundlePath: string; note: string }): Promise<void> => {
      await addDebugBundleNote(params)
    },
  )

  // Read the latest proxy-events.jsonl for a session (Claude or
  // Codex; they share the on-disk layout). Used by saveDebugBundle
  // in the renderer to pull the wire-level capture into the bundle
  // without forcing the whole bundle assembler into the main
  // process. Errors are swallowed inside readProxyEventsForBundle; a missing
  // or unreadable exact proxy log must never break bundle save, but it must be
  // reported as `match:'none'` instead of being replaced with another session's
  // run.
  ipcMain.handle(
    'debug:read-proxy-events',
    async (
      _evt,
      params: { cwd: string; sessionKey?: string | null },
    ): Promise<ProxyEventsBundleSection> => {
      if (!params || typeof params.cwd !== 'string') {
        return {
          proxyEvents: null,
          runDir: null,
          sessionMeta: null,
          match: 'none',
          requestedSessionKey: null,
          matchedSessionSegment: null,
        }
      }
      return readProxyEventsForBundle({
        cwd: params.cwd,
        sessionKey: params.sessionKey ?? null,
      })
    },
  )
}
