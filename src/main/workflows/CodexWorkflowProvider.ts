import { isAbsolute } from 'node:path'

import { AgentProviderFailure, CodexAgentProvider } from 'workflow-mcp'
import type {
  AgentProvider,
} from 'workflow-mcp'

import { getToolPath } from '@main/setup/toolchain.js'

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
export function createCodexWorkflowProvider(): AgentProvider {
  const codexPath = getToolPath('codex', '')
  if (!codexPath || !isAbsolute(codexPath)) {
    return new MissingCodexWorkflowProvider()
  }

  // Never let @openai/codex-sdk discover its optional platform package.
  // Agent Code owns CLI installation, versioning, authentication, and path
  // overrides; the packaged app intentionally excludes those huge optional
  // binaries. An explicit absolute override is therefore a correctness
  // boundary, not merely a bundle-size optimization.
  return new CodexAgentProvider({ codexPathOverride: codexPath })
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
