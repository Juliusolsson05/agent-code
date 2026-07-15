import { app } from 'electron'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  FileWorkflowStore,
  WorkflowService,
} from 'workflow-mcp'
import type { WorkflowProviderFactoryContext } from 'workflow-mcp'

import { createCodexWorkflowProvider } from '@main/workflows/CodexWorkflowProvider.js'
import { ElectronWorkflowWorkerLauncher } from '@main/workflows/ElectronWorkflowWorkerLauncher.js'
import { resolveClaudeAgentType } from '@main/workflows/ClaudeAgentTypeResolver.js'
import { prepareGitWorkflowWorktree } from '@main/workflows/GitWorkflowWorktree.js'
import type { BuiltInMcpServerConfig } from '@mcp/shared/types.js'

export type CreateWorkflowServiceOptions = {
  sessionMcpServers?(sessionId: string): readonly BuiltInMcpServerConfig[]
}

export async function createWorkflowService(
  options: CreateWorkflowServiceOptions = {},
): Promise<WorkflowService> {
  const store = new FileWorkflowStore(join(app.getPath('userData'), 'workflows'))

  // WHY the worker path is relative to THIS BUILT MODULE rather than
  // app.getAppPath(): electron-vite emits workflowWorker.js beside the main
  // entry in both preview and packaged builds. import.meta.url follows the
  // actual bundle (including app.asar), while app.getAppPath()+source-shaped
  // paths are easy to make work in npm start and silently miss in the .app.
  const workerFilePath = fileURLToPath(new URL('./workflowWorker.js', import.meta.url))

  const service = new WorkflowService({
    store,
    // The function is load-bearing: tool setup can change while Agent Code is
    // open, so binding a Codex path at app startup would retain an empty/stale
    // path until restart. WorkflowService invokes this once per new run.
    provider: (context: WorkflowProviderFactoryContext) => createCodexWorkflowProvider({
      mcpServers: context.clientId === undefined
        ? []
        : options.sessionMcpServers?.(context.clientId) ?? [],
    }),
    workerLauncher: new ElectronWorkflowWorkerLauncher(),
    workerFilePath,
    // `agentType` is part of Claude's portable Workflow source language. Resolving the same
    // `.claude/agents/<name>.md` layers here keeps those files runnable in Agent Code while the
    // low-level runtime remains provider-neutral.
    resolveAgentType: resolveClaudeAgentType,
    prepareWorkingDirectory: prepareGitWorkflowWorktree,
    // `null` deliberately means "drop the Claude-specific name and let Codex
    // use its configured default". WorkflowService owns the mapping so it can
    // persist one visible warning per alias before the provider call; doing it
    // inside the adapter would make cache hits and pre-provider failures hide
    // the policy decision from replay.
    modelAliases: {
      inherit: null,
      haiku: null,
      sonnet: null,
      opus: null,
    },
    sandbox: {
      mode: 'read-only',
      approvalPolicy: 'never',
      network: false,
    },
  })
  await service.initialize()
  return service
}
