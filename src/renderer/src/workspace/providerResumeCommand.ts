import { getRendererProviderCapabilities } from '@providers/registry.renderer.capabilities'
import type { AgentProviderKind } from '@shared/types/providerKind'

// Alias of the single provider source of truth (#394 phase 1).
export type ResumableProviderKind = AgentProviderKind

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_/:=.,@%+-]+$/.test(value)) return value
  return `'${value.replace(/'/g, `'\\''`)}'`
}

export function buildProviderResumeCommand(
  kind: ResumableProviderKind,
  cwd: string,
  providerSessionId: string,
): string {
  // WHY this helper is renderer-owned instead of a generic shared shell helper:
  // the duplicate call sites were not trying to build arbitrary commands; they
  // were encoding the provider resume contract shown to the user in copyable
  // prompt text. Keeping the scope narrow avoids inviting unrelated shell
  // construction. The provider-specific invocation (Claude `--resume` flag vs
  // Codex `resume` subcommand) now comes from the registry identity
  // descriptor (#394 phase 2c-2); quoting and the `cd` prefix stay here as
  // caller policy.
  const cd = `cd ${shellQuote(cwd)}`
  const resume = getRendererProviderCapabilities(kind).resumeCommand(
    shellQuote(providerSessionId),
  )
  return `${cd} && ${resume}`
}
