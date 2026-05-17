import type { SessionManager } from '@main/sessionManager.js'
import type { LspManager } from '@main/lspManager.js'
import type { GhostJournalRegistry } from '@main/ghostJournal.js'
import type { DictationDebugJournalRegistry } from '@main/dictationJournal.js'
import type { PasteDebugJournalRegistry } from '@main/pasteDebugJournal.js'

import { registerSessionIpc } from '@main/ipc/session.js'
import { registerProviderIpc } from '@main/ipc/provider.js'
import { registerLspIpc } from '@main/ipc/lsp.js'
import { registerFsIpc } from '@main/ipc/fs.js'
import { registerSessionsIpc } from '@main/ipc/sessions.js'
import { registerWorkspaceIpc } from '@main/ipc/workspace.js'
import { registerGhostIpc } from '@main/ipc/ghost.js'
import { registerDebugIpc } from '@main/ipc/debug.js'
import { registerGitIpc } from '@main/ipc/git.js'
import { registerPerformanceIpc } from '@main/ipc/performance.js'
import { registerEditorFsIpc } from '@main/ipc/editorFs.js'
import { registerSetupIpc } from '@main/ipc/setup.js'
import { registerWorktreeActivityIpc } from '@main/ipc/worktreeActivity.js'
import { registerDictationIpc } from '@main/ipc/dictation.js'
import { registerPasteDebugIpc } from '@main/ipc/pasteDebug.js'
import { registerDevDebugIpc } from '@main/ipc/devDebug.js'
import { installPerformanceIpcInstrumentation } from '@main/performance/instrumentIpc.js'
import type { WorktreeActivityIndex } from '@main/worktreeActivity/WorktreeActivityIndex.js'
import { registerOrchestrationIpc } from '@main/ipc/orchestration.js'
import { registerAiWorkspaceIpc } from '@main/ipc/aiWorkspace.js'
import type { OrchestrationBridge } from '@main/orchestration/OrchestrationBridge.js'
import type { AiWorkspaceRegistry } from '@main/aiWorkspace/AiWorkspaceRegistry.js'

// IPC registration aggregator.
//
// main/index.ts calls registerAllIpc(deps) exactly once, right after
// services are constructed. Each domain module does its own
// ipcMain.handle wiring inside its register function. Passing deps
// explicitly (rather than importing singletons into each module)
// keeps the wiring visible here and makes the domain files testable
// in isolation — they don't reach into module-scoped state.

export type IpcDeps = {
  manager: SessionManager
  lspManager: LspManager
  ghostJournals: GhostJournalRegistry
  dictationDebugJournals: DictationDebugJournalRegistry
  pasteDebugJournals: PasteDebugJournalRegistry
  worktreeActivityIndex: WorktreeActivityIndex
  orchestrationBridge: OrchestrationBridge
  aiWorkspaceRegistry: AiWorkspaceRegistry
}

export function registerAllIpc(deps: IpcDeps): void {
  registerPerformanceIpc(deps.manager)
  installPerformanceIpcInstrumentation()
  registerEditorFsIpc()
  registerSessionIpc(deps.manager, deps.pasteDebugJournals)
  registerProviderIpc()
  registerLspIpc(deps.lspManager)
  registerFsIpc()
  registerSessionsIpc()
  registerWorkspaceIpc()
  registerGhostIpc(deps.ghostJournals)
  registerDebugIpc()
  registerGitIpc()
  registerWorktreeActivityIpc(deps.worktreeActivityIndex)
  registerSetupIpc()
  registerDictationIpc({ dictationDebugJournals: deps.dictationDebugJournals })
  registerPasteDebugIpc({ pasteDebugJournals: deps.pasteDebugJournals })
  registerDevDebugIpc()
  registerOrchestrationIpc(deps.orchestrationBridge)
  registerAiWorkspaceIpc(deps.aiWorkspaceRegistry)
}
