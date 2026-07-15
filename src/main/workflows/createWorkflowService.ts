import { app } from 'electron'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  FileWorkflowStore,
  WorkflowService,
} from 'workflow-mcp'

import { createCodexWorkflowProvider } from '@main/workflows/CodexWorkflowProvider.js'
import { ElectronWorkflowWorkerLauncher } from '@main/workflows/ElectronWorkflowWorkerLauncher.js'
import { resolveClaudeAgentType } from '@main/workflows/ClaudeAgentTypeResolver.js'
import { prepareGitWorkflowWorktree } from '@main/workflows/GitWorkflowWorktree.js'

export async function createWorkflowService(): Promise<WorkflowService> {
  const workflowStateRoot = join(app.getPath('userData'), 'workflows')
  const store = new FileWorkflowStore(workflowStateRoot)

  // WHY the worker path is relative to THIS BUILT MODULE rather than
  // app.getAppPath(): electron-vite emits workflowWorker.js beside the main
  // entry in both preview and packaged builds. import.meta.url follows the
  // actual bundle (including app.asar), while app.getAppPath()+source-shaped
  // paths are easy to make work in npm start and silently miss in the .app.
  const workerFilePath = fileURLToPath(new URL('./workflowWorker.js', import.meta.url))
  const providerHostFilePath = fileURLToPath(new URL('./workflowProviderHost.js', import.meta.url))
  const interactiveCodexHome = process.env.CODEX_HOME ?? join(app.getPath('home'), '.codex')

  const service = new WorkflowService({
    store,
    // WHY this deliberately does not forward the parent chat's Agent Code MCP
    // server: these workflow attempts run read-only and may be recovered
    // automatically after a confirmed process-tree kill. The parent server
    // exposes mutating orchestration and workspace tools, so inheriting it
    // would make replay-safety unknowable. A future workflow-facing MCP surface
    // needs per-tool effect/idempotency metadata before it can be admitted here.
    // The factory remains lazy because tool setup can change while Agent Code
    // is open; binding a Codex path at startup would retain an empty/stale path.
    provider: () => createCodexWorkflowProvider({
      providerHostFilePath,
      codexHome: join(workflowStateRoot, 'codex-home'),
      authenticationFile: join(interactiveCodexHome, 'auth.json'),
      // WHY the interactive home is a session source but never CODEX_HOME for the child: upgrades
      // must be able to resume thread IDs persisted before workflow isolation existed. Workflow MCP
      // imports only the exact requested rollout; normal config, plugins, apps, and MCP servers
      // remain outside the replay-safe provider boundary.
      sessionSourceHome: interactiveCodexHome,
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
