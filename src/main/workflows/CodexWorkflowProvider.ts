import { DISABLED_CODEX_EXTERNAL_CONTROL } from '@providers/shared/runtime/externalControlExclusion.js'
import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
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
  prepareAuthentication?(): void | Promise<void>
  sessionSourceHome?: string
  isCliUpdateReserved?: () => boolean
}

const executableEvidenceCache = new Map<string, {
  mtimeMs: number
  size: number
  sha256: string
}>()

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
  if (options.isCliUpdateReserved?.() === true) return new UpdatingCodexWorkflowProvider()
  const codexPath = getToolPath('codex', '')
  if (!codexPath || !isAbsolute(codexPath)) {
    return new MissingCodexWorkflowProvider()
  }
  const executableEvidence = codexExecutableEvidence(codexPath)

  // WHY all three boundaries are explicit here: the packaged app owns the
  // Codex executable, the child-process module, and the configuration root.
  // Falling back to SDK discovery works in a source checkout but breaks after
  // packaging; falling back to the interactive CODEX_HOME is worse because it
  // silently gives automatically replayed workflow attempts whatever MCP
  // servers, plugins, and apps the user enabled for an ordinary chat.
  return new CodexAgentProvider({
    codexPathOverride: codexPath,
    config: DISABLED_CODEX_EXTERNAL_CONTROL,
    providerHostFilePath: options.providerHostFilePath,
    configurationIsolation: {
      codexHome: options.codexHome,
      ...(options.authenticationFile === undefined
        ? {}
        : { authenticationFile: options.authenticationFile }),
      ...(options.prepareAuthentication === undefined
        ? {}
        : { prepareAuthentication: options.prepareAuthentication }),
      ...(options.sessionSourceHome === undefined
        ? {}
        : { sessionSourceHome: options.sessionSourceHome }),
    },
    // A private CODEX_HOME removes user/project configuration, but Codex also loads system/admin
    // and managed layers. Agent Code does not yet inspect and fingerprint every effective layer,
    // so claiming "disabled" here would turn missing evidence into permission for automatic
    // replay. Keep recovery fail-closed until the effective-config inspector exists.
    capabilities: { inheritedMcpServers: 'unknown' },
    ...(executableEvidence === undefined
      ? {}
      : { executableEvidence }),
  })
}

function codexExecutableEvidence(path: string): {
  path: string
  sha256: string
} | undefined {
  try {
    const stat = statSync(path)
    const cached = executableEvidenceCache.get(path)
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      return { path, sha256: cached.sha256 }
    }
    // WHY hash the executable bytes rather than report the SDK package pin as the CLI version:
    // Agent Code passes an explicit setup-resolved binary, so the SDK's bundled artifact may never
    // execute. mtime/size cache the expensive read across run factories while SHA-256 makes crash
    // diagnostics and future recovery fingerprints identify the actual launched bytes.
    const sha256 = createHash('sha256').update(readFileSync(path)).digest('hex')
    executableEvidenceCache.set(path, { mtimeMs: stat.mtimeMs, size: stat.size, sha256 })
    return { path, sha256 }
  } catch {
    // The ordinary provider path will produce a durable spawn failure. Missing evidence must not
    // be replaced with a guessed SDK version because that was the audit bug this field fixes.
    return undefined
  }
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

class UpdatingCodexWorkflowProvider implements AgentProvider {
  readonly name = 'codex'

  async execute(): Promise<never> {
    // A run can be persisted just before it asks the provider factory for an execution boundary.
    // Failing through the normal provider path makes that race durable and recoverable while still
    // guaranteeing no new Codex process observes a half-replaced executable.
    throw new AgentProviderFailure(
      'Workflow execution is temporarily deferred while Agent Code updates the Codex CLI. Resume the workflow after the update finishes.',
      { code: 'codex-cli-update-in-progress', retryable: true },
    )
  }
}
