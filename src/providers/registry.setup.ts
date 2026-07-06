// Provider setup descriptors — plain data, ZERO runtime imports.
//
// WHY this is a separate registry file instead of a field on
// MainProviderConfig in registry.main.ts: the setup modules
// (binaryResolver, prerequisites) are imported by toolchain, which the
// provider SESSION classes import (claudeSession pulls getToolPath and
// resolveBundledTool). If binaryResolver imported registry.main to read
// a setup descriptor, the chain binaryResolver → registry.main →
// claudeSession → toolchain → binaryResolver would be a genuine ESM
// module cycle with init-order landmines. This mirrors the
// registry.renderer.capabilities.ts split, which exists for the exact
// same reason on the renderer side (Feed → registry.renderer →
// TileLeaf → Feed).
//
// The descriptors are pure literals so this file is importable from
// anywhere in main without dragging in node-pty, proxies, or fs.

import {
  AGENT_PROVIDER_KINDS,
  isAgentProviderKind,
  type AgentProviderKind,
} from '@shared/types/providerKind.js'

export type ProviderSetupDescriptor = {
  /** The executable name resolved on PATH and cached by toolchain.
   *  Today it equals the provider kind for both shipped providers —
   *  declaring it explicitly makes the kind↔binary coupling visible
   *  and breakable (a future provider whose CLI binary isn't named
   *  after its kind just says so here). */
  binaryName: string
  /** Human label shown in the SetupGate row. */
  label: string
  /** Whether a missing binary blocks app launch. Both shipped
   *  providers are launch-blocking today; plug-and-play likely turns
   *  this into a user-level "installed providers" concept later
   *  (#394 §13.5) — the flag is here so that change is one edit per
   *  provider. */
  required: boolean
  /** SetupGate detail line. */
  detail: string
}

const claudeSetup: ProviderSetupDescriptor = {
  binaryName: 'claude',
  label: 'Claude Code',
  required: true,
  detail: 'Install and sign in to Claude Code before using Claude panes.',
}

const codexSetup: ProviderSetupDescriptor = {
  binaryName: 'codex',
  label: 'Codex',
  required: true,
  detail: 'Install and sign in to Codex before using Codex panes.',
}

const opencodeSetup: ProviderSetupDescriptor = {
  binaryName: 'opencode',
  label: 'OpenCode',
  // FIRST required:false provider (#406 blocker 5): opencode must not
  // block app launch for the vast majority of installs that don't
  // have the binary. Verify the SetupGate soft-handles this before
  // the branch merges.
  required: false,
  detail: 'Install the opencode CLI to use OpenCode panes. Optional.',
}

const providerSetupDescriptors: Record<AgentProviderKind, ProviderSetupDescriptor> = {
  claude: claudeSetup,
  codex: codexSetup,
  opencode: opencodeSetup,
}

export function getProviderSetupDescriptor(id: string): ProviderSetupDescriptor {
  if (!isAgentProviderKind(id)) throw new Error(`Unknown provider: ${id}`)
  return providerSetupDescriptors[id]
}

/** Iteration helper for setup modules deriving their tool tables. */
export function listProviderSetupDescriptors(): Array<
  [AgentProviderKind, ProviderSetupDescriptor]
> {
  return AGENT_PROVIDER_KINDS.map(kind => [kind, providerSetupDescriptors[kind]])
}
