// See docs/design/provider-switching.md for the progress and live-session lock
// invariants owned by this IPC boundary.
import type { AgentProviderKind } from '@shared/types/providerKind.js'
import { BrowserWindow, dialog, ipcMain } from 'electron'
import type { MessageBoxOptions } from 'electron'
import type { SessionManager } from '@main/sessionManager.js'

import { switchProvider } from '@main/providerSwitch/switchProvider.js'
import type { SwitchContextPolicy } from '@main/providerSwitch/switchProvider.js'
import { compactSourceBeforeSwitch } from '@main/providerSwitch/compactBeforeSwitch.js'
import { compactOnArrival } from '@main/providerSwitch/compactOnArrival.js'
import type { CompactOnArrivalRequest } from '@main/providerSwitch/compactOnArrival.js'
import { duplicateSession } from '@main/providerSwitch/duplicateSession.js'
import {
  listRewindPrompts,
  rewindSession,
} from '@main/providerSwitch/rewindSession.js'
import type { RewindSessionRequest } from '@main/providerSwitch/rewindSession.js'
import type { ListRewindPromptsRequest } from '@shared/types/transcriptRewind.js'

// Provider-level session transforms.
//
// The mutating handlers here write a NEW transcript to disk and return a new
// providerSessionId. Duplicate and rewind never modify the source. Provider
// switch also stays read-only when history fits, but an oversized switch asks
// the live source provider to append its own native compaction before the new
// target transcript is written. Prompt listing is the read-only half of rewind
// and returns stable raw-record addresses. The renderer passes the returned id
// to replaceSession(...) to swap a pane onto the transformed conversation
// without tearing down the tile tree.
//
// Why a separate file: these share orchestration shape (read source →
// transform → write clone → return id) but the transforms themselves
// live under main/providerSwitch/. Grouping the IPC handlers here
// keeps session.ts focused on lifecycle + I/O.

export function registerProviderIpc(manager: SessionManager): void {
  const switchesInFlight = new Set<string>()
  ipcMain.handle(
    'session:switch-provider',
    async (
      _evt,
      params: {
        sourceKind: AgentProviderKind
        targetKind?: AgentProviderKind
        sourceProviderSessionId: string
        cwd: string
        sourceCwd?: string
        targetCwd?: string
        sourceSessionId?: string
        contextPolicy?: Partial<SwitchContextPolicy>
        sourceCompactionConfirmed?: boolean
      },
    ) => {
      const lockId = params.sourceSessionId ?? `${params.sourceKind}:${params.sourceProviderSessionId}`
      if (switchesInFlight.has(lockId)) {
        throw new Error('A provider switch is already in progress for this agent.')
      }
      switchesInFlight.add(lockId)
      try {
        return await switchProvider(params, {
          compactSource: async (request, plan) => {
            // WHY the confirmation can arrive already given: this dialog is
            // per-agent, and the bulk switch confirms ONCE for a batch before
            // fanning out one request per agent. Seventeen modal dialogs in a
            // row is not consent, it is a thing users click through. The gate
            // stays here rather than moving into switchProvider because the
            // dialog needs the requesting window, which only this handler has.
            //
            // Nothing else changed for the opt-in path: a caller that does not
            // set the flag still gets the native confirmation it always got,
            // and this callback is unreachable at all under the default policy
            // — switchProvider never invokes compactSource when
            // allowSourceTurns is false.
            if (plan.kind === 'requires-compaction' && !params.sourceCompactionConfirmed) {
              const window = BrowserWindow.fromWebContents(_evt.sender)
              const options: MessageBoxOptions = {
                type: 'warning',
                buttons: ['Compact and switch', 'Cancel'],
                defaultId: 1,
                cancelId: 1,
                noLink: true,
                title: 'Compact conversation before switching?',
                message: `This conversation is too large for ${params.targetKind ?? 'the target provider'}.`,
                detail: 'Switching requires the source provider to compact its live history first. This changes the current source session and cannot be undone.',
              }
              const confirmation = window
                ? await dialog.showMessageBox(window, options)
                : await dialog.showMessageBox(options)
              if (confirmation.response !== 0) {
                throw new Error('Provider switch cancelled before source compaction.')
              }
            }
            return await compactSourceBeforeSwitch(manager, request, plan, () => {
              if (!_evt.sender.isDestroyed() && request.sourceSessionId) {
                _evt.sender.send('session:provider-switch-progress', {
                  sourceSessionId: request.sourceSessionId,
                  phase: 'summarizing',
                  message: `Codex compacted. Creating a portable handoff for ${request.targetKind ?? 'the target provider'}…`,
                })
              }
            })
          },
          onProgress: progress => {
            // WHY progress is pushed from the owning IPC request rather than
            // inferred from processActive in the renderer: ordinary turns and
            // native compaction both make the provider busy. Only this
            // coordinator knows that the busy period is blocking a switch.
            if (!_evt.sender.isDestroyed()) {
              _evt.sender.send('session:provider-switch-progress', progress)
            }
          },
        })
      } finally {
        switchesInFlight.delete(lockId)
      }
    },
  )

  // Arrival compaction — the second half of a quota-independent switch, run on
  // the pane the switch just created (see providerSwitch/compactOnArrival.ts).
  //
  // WHY a lock keyed on the NEW session id, separate from `switchesInFlight`
  // above: that lock is keyed on the SOURCE and is released the moment the
  // transaction returns, which is before the renderer has even called
  // `replaceSession`. Two arrival compactions on one pane would send `/compact`
  // twice and then race each other's wait for "a compaction newer than the
  // baseline" — the second would accept the first one's carrier and report
  // success for work it did not do.
  //
  // WHY this never throws across IPC: the pane is already live with its full
  // history. Every failure comes back as `{ ok: false, message }` for the
  // caller to show as a toast; see the module header.
  const arrivalsInFlight = new Set<string>()
  ipcMain.handle('session:compact-after-switch', async (_evt, params: CompactOnArrivalRequest) => {
    if (arrivalsInFlight.has(params.sessionId)) {
      return { ok: false, message: 'Arrival compaction already running.' }
    }
    arrivalsInFlight.add(params.sessionId)
    try {
      return await compactOnArrival(manager, params, progress => {
        // Same channel as the switch transaction's progress, addressed to the
        // new session id. The renderer subscribes per session id, so one
        // channel carrying both halves keeps the pane's banner continuous
        // across the replacement instead of blinking between two mechanisms.
        if (!_evt.sender.isDestroyed()) {
          _evt.sender.send('session:provider-switch-progress', progress)
        }
      })
    } finally {
      arrivalsInFlight.delete(params.sessionId)
    }
  })

  ipcMain.handle(
    'session:duplicate',
    async (
      _evt,
      params: {
        provider: AgentProviderKind
        sourceProviderSessionId: string
        cwd: string
        sourceCwd?: string
        targetCwd?: string
      },
    ) => {
      return await duplicateSession(params)
    },
  )

  // Rewind the focused pane's transcript to just before a selected
  // user prompt. Produces a NEW provider session id; the source file
  // is never touched. The renderer passes the returned id to
  // `replaceSession(...)` to re-home the pane, and prefills
  // `promptText` as an unsent draft. See
  // `src/main/providerSwitch/rewindSession.ts` for the slicing rules.
  ipcMain.handle(
    'session:list-rewind-prompts',
    async (_evt, params: ListRewindPromptsRequest) => {
      return await listRewindPrompts(params)
    },
  )

  ipcMain.handle(
    'session:rewind-to-prompt',
    async (_evt, params: RewindSessionRequest) => {
      return await rewindSession(params)
    },
  )
}
