import { isAbsolute } from 'node:path'

import { AgentProviderFailure, CodexAgentProvider } from 'workflow-mcp'
import type {
  AgentProvider,
} from 'workflow-mcp'

import { getToolPath } from '@main/setup/toolchain.js'

export type CodexWorkflowProviderOptions = {
  providerHostFilePath: string
  codexHome: string
  authenticationFile?: string
}

/**
 * Resolve the setup-owned Codex binary once per workflow run.
 *
 * WHY this returns a failing provider instead of throwing: WorkflowService
 * calls the provider factory after allocating and persisting the run. A throw
 * at that seam can strand a queued manifest before runWorkflow owns terminal
 * event handling. Returning a real AgentProvider moves the failure into the
 * ordinary agent-attempt path, where it becomes a durable, visible outcome.
 * It also lets Agent Code start for a Claude-only user; installing/configuring
 * Codex later takes effect on the next run without restarting the app.
 */
export function createCodexWorkflowProvider(
  options: CodexWorkflowProviderOptions,
): AgentProvider {
  const codexPath = getToolPath('codex', '')
  if (!codexPath || !isAbsolute(codexPath)) {
    return new MissingCodexWorkflowProvider()
  }

  // WHY all three boundaries are explicit here: the packaged app owns the
  // Codex executable, the child-process module, and the configuration root.
  // Falling back to SDK discovery works in a source checkout but breaks after
  // packaging; falling back to the interactive CODEX_HOME is worse because it
  // silently gives automatically replayed workflow attempts whatever MCP
  // servers, plugins, and apps the user enabled for an ordinary chat.
  return new CodexAgentProvider({
    codexPathOverride: codexPath,
    providerHostFilePath: options.providerHostFilePath,
    configurationIsolation: {
      codexHome: options.codexHome,
      ...(options.authenticationFile === undefined
        ? {}
        : { authenticationFile: options.authenticationFile }),
    },
    // This is an attestation backed by configurationIsolation, not a claim
    // inferred from an empty options object. Workflow MCP rejects this value
    // without an isolated CODEX_HOME because normal Codex configuration can
    // otherwise reintroduce unclassified external tools behind our back.
    capabilities: { inheritedMcpServers: 'disabled' },
  })
}

class MissingCodexWorkflowProvider implements AgentProvider {
  readonly name = 'codex'

  async execute(): Promise<never> {
    throw new AgentProviderFailure(
      'Workflow execution requires a configured Codex CLI. Open Agent Code setup, resolve Codex to an absolute executable path, then resume or start the workflow again.',
      { code: 'codex-cli-unavailable' },
    )
  }
}
