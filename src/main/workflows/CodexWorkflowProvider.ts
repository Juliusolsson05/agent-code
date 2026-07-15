import { isAbsolute } from 'node:path'

import { AgentProviderFailure, CodexAgentProvider } from 'workflow-mcp'
import type {
  AgentProvider,
} from 'workflow-mcp'

import { getToolPath } from '@main/setup/toolchain.js'
import type { BuiltInMcpServerConfig } from '@mcp/shared/types.js'

export type CodexWorkflowProviderOptions = {
  mcpServers?: readonly BuiltInMcpServerConfig[]
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
  options: CodexWorkflowProviderOptions = {},
): AgentProvider {
  const codexPath = getToolPath('codex', '')
  if (!codexPath || !isAbsolute(codexPath)) {
    return new MissingCodexWorkflowProvider()
  }

  // Never let @openai/codex-sdk discover its optional platform package.
  // Agent Code owns CLI installation, versioning, authentication, and path
  // overrides; the packaged app intentionally excludes those huge optional
  // binaries. An explicit absolute override is therefore a correctness
  // boundary, not merely a bundle-size optimization.
  const mcpServers = options.mcpServers ?? []
  const mcpConfig = Object.fromEntries(mcpServers.map(server => [
    server.name,
    {
      url: server.url,
      http_headers: { ...server.headers },
    },
  ]))
  return new CodexAgentProvider({
    codexPathOverride: codexPath,
    // The SDK flattens this object into the same `mcp_servers.*` CLI overrides used by normal
    // Agent Code sessions. Omitting the whole block for unscoped/renderer resumes avoids inventing
    // credentials or silently inheriting a different user's global Codex MCP configuration.
    ...(mcpServers.length === 0 ? {} : { config: { mcp_servers: mcpConfig } }),
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
