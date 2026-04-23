import type { SessionManager } from '../sessionManager.js'
import type { LspManager } from '../lspManager.js'
import type { GhostJournalRegistry } from '../ghostJournal.js'

import { registerSessionIpc } from './session.js'
import { registerProviderIpc } from './provider.js'
import { registerLspIpc } from './lsp.js'
import { registerFsIpc } from './fs.js'
import { registerSessionsIpc } from './sessions.js'
import { registerWorkspaceIpc } from './workspace.js'
import { registerGhostIpc } from './ghost.js'
import { registerDebugIpc } from './debug.js'
import { registerGitIpc } from './git.js'

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
}

export function registerAllIpc(deps: IpcDeps): void {
  registerSessionIpc(deps.manager)
  registerProviderIpc()
  registerLspIpc(deps.lspManager)
  registerFsIpc()
  registerSessionsIpc()
  registerWorkspaceIpc()
  registerGhostIpc(deps.ghostJournals)
  registerDebugIpc()
  registerGitIpc()
}
