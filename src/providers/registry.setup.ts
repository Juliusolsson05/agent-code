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

import { AGENT_PROVIDER_KINDS, isAgentProviderKind } from '@shared/types/providerKind.js'
import type { AgentProviderKind } from '@shared/types/providerKind.js'

export type ProviderSetupDescriptor = {
  /** The executable name resolved on PATH and cached by toolchain.
   *  Today it equals the provider kind for both shipped providers —
   *  declaring it explicitly makes the kind↔binary coupling visible
   *  and breakable (a future provider whose CLI binary isn't named
   *  after its kind just says so here). */
  binaryName: string
  /** Human label shown in the SetupGate row. */
  label: string
  // `required: boolean` lived here until #995. Claude and Codex were
  // launch-blocking, so a Mac without both CLIs met a gate it could not pass,
  // even when another provider was installed or bundled. No provider is
  // required now; readiness.ts decides what a first run opens with.
  /** SetupGate detail line. */
  detail: string
  /**
   * How a user installs this CLI on a Mac that has nothing, shown copyable in
   * the SetupGate.
   *
   * WHY these commands and not `npm install -g`: a fresh Mac has no Node and
   * no Homebrew, so an npm or brew command fails before it starts. Each
   * command is the provider's own native installer, checked on 2026-09-19 by
   * fetching the URL (every one resolves to a real script). Grok is the one
   * exception: its only published distribution found is the npm package
   * `@xai-official/grok` (registry.npmjs.org, and the recording machine's own
   * install), so its hint says npm.
   */
  install: { command: string; docsUrl: string }
}

const claudeSetup: ProviderSetupDescriptor = {
  binaryName: 'claude',
  label: 'Claude Code',
  detail: 'Install and sign in to Claude Code to use Claude panes.',
  install: {
    command: 'curl -fsSL https://claude.ai/install.sh | bash',
    docsUrl: 'https://code.claude.com/docs/en/setup',
  },
}

const codexSetup: ProviderSetupDescriptor = {
  binaryName: 'codex',
  label: 'Codex',
  detail: 'Install and sign in to Codex to use Codex panes.',
  install: {
    // The same installer cliUpdateOrchestrator runs for native Codex updates.
    command: 'curl -fsSL https://chatgpt.com/codex/install.sh | sh',
    docsUrl: 'https://github.com/openai/codex',
  },
}

const opencodeSetup: ProviderSetupDescriptor = {
  binaryName: 'opencode',
  label: 'OpenCode',
  // The packaged app ships this CLI (#994), so on a release build this row
  // reads "Bundled" and the install command is never needed. It matters in
  // dev builds and if a user removed the bundled runtime.
  detail: 'Install the opencode CLI to use OpenCode panes.',
  install: {
    command: 'curl -fsSL https://opencode.ai/install | bash',
    docsUrl: 'https://opencode.ai/docs',
  },
}

const grokSetup: ProviderSetupDescriptor = {
  binaryName: 'grok',
  label: 'Grok',
  detail: 'Install the Grok CLI to use Grok panes.',
  install: {
    command: 'npm install -g @xai-official/grok',
    docsUrl: 'https://www.npmjs.com/package/@xai-official/grok',
  },
}

const piSetup: ProviderSetupDescriptor = {
  binaryName: 'pi',
  label: 'Pi',
  // An npm CLI (it needs a Node runtime and a node_modules tree), so it is
  // PATH-resolved like Grok, not bundled like OpenCode's single binary.
  // `pi /login` (or an API key) is done in pi itself; Agent Code never
  // touches ~/.pi/agent/auth.json.
  detail: 'Install the pi CLI (Node 22.19+) and sign in with /login inside pi to use Pi panes.',
  install: {
    command: 'npm install -g @earendil-works/pi-coding-agent',
    docsUrl: 'https://pi.dev',
  },
}

const providerSetupDescriptors: Record<AgentProviderKind, ProviderSetupDescriptor> = {
  claude: claudeSetup,
  codex: codexSetup,
  opencode: opencodeSetup,
  grok: grokSetup,
  pi: piSetup,
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
