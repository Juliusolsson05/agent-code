// See docs/design/provider-switching.md for the progress and live-session lock
// invariants owned by this IPC boundary.
import type { AgentProviderKind } from '@shared/types/providerKind.js'
import { BrowserWindow, dialog, ipcMain } from 'electron'
import type { MessageBoxOptions } from 'electron'
import type { SessionManager } from '@main/sessionManager.js'

import { switchProvider } from '@main/providerSwitch/switchProvider.js'
import { compactSourceBeforeSwitch } from '@main/providerSwitch/compactBeforeSwitch.js'
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
            if (plan.kind === 'requires-compaction') {
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
