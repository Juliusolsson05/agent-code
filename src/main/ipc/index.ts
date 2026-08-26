import type { SessionManager } from '@main/sessionManager.js'
import { EditorFsRootRegistry } from './editorFsRootRegistry.js'
import type { LspManager } from '@main/lspManager.js'
import type { GhostJournalRegistry } from '@main/ghostJournal.js'
import type { DictationDebugJournalRegistry } from '@main/dictationJournal.js'
import type { PasteDebugJournalRegistry } from '@main/pasteDebugJournal.js'
import type { SessionRecorderManager } from '@main/recording/SessionRecorderManager.js'
import type { AgentCodeConventionsService } from '@main/agentCodeConventions/AgentCodeConventionsService.js'

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
import { registerEditorFsWatchIpc } from '@main/ipc/editorFsWatch.js'
import { registerSetupIpc } from '@main/ipc/setup.js'
import { registerWorktreeActivityIpc } from '@main/ipc/worktreeActivity.js'
import { registerDictationIpc } from '@main/ipc/dictation.js'
import { registerPasteDebugIpc } from '@main/ipc/pasteDebug.js'
import { registerDevDebugIpc } from '@main/ipc/devDebug.js'
import { installPerformanceIpcInstrumentation } from '@main/performance/instrumentIpc.js'
import type { WorktreeActivityIndex } from '@main/worktreeActivity/WorktreeActivityIndex.js'
import { registerOrchestrationIpc } from '@main/ipc/orchestration.js'
import { registerAgentManagementIpc } from '@main/ipc/agentManagement.js'
import { registerAiWorkspaceIpc } from '@main/ipc/aiWorkspace.js'
import { registerRenderedContentIpc } from '@main/ipc/renderedContent.js'
import { registerCaffeinateIpc } from '@main/ipc/caffeinate.js'
import { registerRemoteIpc } from '@main/ipc/remote.js'
import type { OrchestrationBridge } from '@main/orchestration/OrchestrationBridge.js'
import type { AgentManagementBridge } from '@main/agentManagement/AgentManagementBridge.js'
import type { AiWorkspaceRegistry } from '@main/aiWorkspace/AiWorkspaceRegistry.js'
import type { CaffeinateController } from '@main/caffeinate/CaffeinateController.js'
import type { RemoteController } from '@main/remote/RemoteController.js'
import type { AppRunJournal } from '@main/incident/AppRunJournal.js'
import { registerIncidentIpc } from '@main/ipc/incident.js'
import { registerLifecycleIpc } from '@main/ipc/lifecycle.js'
import { registerUsageIpc } from '@main/ipc/usage.js'
import { registerCliUpdatesIpc } from '@main/ipc/cliUpdates.js'
import type { CliUpdateOrchestrator } from '@main/setup/cliUpdateOrchestrator.js'
import { registerWorkflowIpc } from '@main/ipc/workflows.js'
import { registerAgentCodeConventionsIpc } from '@main/ipc/agentCodeConventions.js'
import type { WorkflowBridge } from '@main/workflows/WorkflowBridge.js'

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
  // Null in a normal build — only constructed when session recording is gated
  // on (main/index.ts). The dev-debug IPC needs it for the Attach-Recording-
  // Note handlers (plan §7b).
  sessionRecorders: SessionRecorderManager | null
  worktreeActivityIndex: WorktreeActivityIndex
  orchestrationBridge: OrchestrationBridge
  agentManagementBridge: AgentManagementBridge
  aiWorkspaceRegistry: AiWorkspaceRegistry
  caffeinateController: CaffeinateController
  remoteController: RemoteController
  appRunJournal: AppRunJournal
  cliUpdateOrchestrator: CliUpdateOrchestrator
  workflowBridge: WorkflowBridge
  agentCodeConventionsService: AgentCodeConventionsService
}

export function registerAllIpc(deps: IpcDeps): void {
  const editorFsRoots = new EditorFsRootRegistry(deps.manager)
  registerPerformanceIpc(deps.manager)
  installPerformanceIpcInstrumentation()
  registerEditorFsIpc(editorFsRoots)
  registerEditorFsWatchIpc(editorFsRoots)
  registerSessionIpc(deps.manager, deps.pasteDebugJournals)
  registerProviderIpc(deps.manager)
  registerLspIpc(deps.lspManager, editorFsRoots, deps.aiWorkspaceRegistry)
  registerFsIpc()
  registerSessionsIpc()
  registerWorkspaceIpc(deps.manager)
  registerGhostIpc(deps.ghostJournals)
  registerDebugIpc()
  registerGitIpc()
  registerWorktreeActivityIpc(deps.worktreeActivityIndex)
  registerSetupIpc()
  registerDictationIpc({
    dictationDebugJournals: deps.dictationDebugJournals,
    appRunJournal: deps.appRunJournal,
  })
  registerPasteDebugIpc({ pasteDebugJournals: deps.pasteDebugJournals })
  registerDevDebugIpc(deps.sessionRecorders)
  registerOrchestrationIpc(deps.orchestrationBridge)
  registerAgentManagementIpc(deps.agentManagementBridge)
  registerAiWorkspaceIpc(deps.aiWorkspaceRegistry)
  registerRenderedContentIpc()
  registerCaffeinateIpc(deps.caffeinateController)
  registerRemoteIpc(deps.remoteController)
  registerIncidentIpc(deps.appRunJournal)
  registerLifecycleIpc(deps.appRunJournal)
  registerUsageIpc()
  registerCliUpdatesIpc(deps.cliUpdateOrchestrator)
  registerWorkflowIpc(deps.workflowBridge)
  registerAgentCodeConventionsIpc(deps.agentCodeConventionsService)
}
