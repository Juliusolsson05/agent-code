import { ipcMain } from 'electron'

import { switchProvider } from '@main/providerSwitch/switchProvider.js'
import { duplicateSession } from '@main/providerSwitch/duplicateSession.js'
import {
  rewindSession,
  type RewindSessionRequest,
} from '@main/providerSwitch/rewindSession.js'

// Provider-level session transforms.
//
// All three handlers here write a NEW transcript to disk and return a
// new providerSessionId; the source file is never modified. The
// renderer passes the returned id to replaceSession(...) to swap a
// pane onto the transformed conversation without tearing down the
// tile tree.
//
// Why a separate file: these share orchestration shape (read source →
// transform → write clone → return id) but the transforms themselves
// live under main/providerSwitch/. Grouping the IPC handlers here
// keeps session.ts focused on lifecycle + I/O.

export function registerProviderIpc(): void {
  ipcMain.handle(
    'session:switch-provider',
    async (
      _evt,
      params: {
        sourceKind: 'claude' | 'codex'
        sourceProviderSessionId: string
        cwd: string
        sourceCwd?: string
        targetCwd?: string
      },
    ) => {
      return await switchProvider(params)
    },
  )

  ipcMain.handle(
    'session:duplicate',
    async (
      _evt,
      params: {
        provider: 'claude' | 'codex'
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
    'session:rewind-to-prompt',
    async (_evt, params: RewindSessionRequest) => {
      return await rewindSession(params)
    },
  )
}
