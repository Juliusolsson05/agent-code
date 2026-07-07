// Renderer-side provider registry — browser-safe, no Node imports.
//
// TileTree and workspaceStore import from HERE, not from registry.ts.
// This file only imports renderer configs which contain TileLeaf
// components and parser functions — no session factories, no fs, no pty.

import type { ComponentType } from 'react'
import type { RendererProviderConfig } from '@shared/types/providerConfig'
import { type AgentProviderKind, isAgentProviderKind } from '@shared/types/providerKind'
import { TileLeaf } from '@renderer/workspace/tile-tree/TileLeaf'
import type { TileLeafProps } from '@shared/types/providerConfig'
import {
  getRendererProviderCapabilities,
} from '@providers/registry.renderer.capabilities'

const claudeRenderer: RendererProviderConfig = {
  ...getRendererProviderCapabilities('claude'),
  TileLeaf: TileLeaf as ComponentType<TileLeafProps>,
}

const codexRenderer: RendererProviderConfig = {
  ...getRendererProviderCapabilities('codex'),
  TileLeaf: TileLeaf as ComponentType<TileLeafProps>,
}

// Exhaustive Record<AgentProviderKind, …> — same compile-time checklist as
// the main registry. A new provider kind cannot be added to the shared
// source of truth without also giving it a renderer config here.
const opencodeRenderer: RendererProviderConfig = {
  ...getRendererProviderCapabilities('opencode'),
  // OpenCode intentionally uses only the shared Agent surface today.
  // WHY not expose AgentTerminalLeaf here: OpenCode's runtime has no
  // provider PTY for Agent Code to mirror, so "Terminal" cannot mean the same
  // thing it means for Claude/Codex. The display-policy layer pins OpenCode to
  // Agent mode until a real native OpenCode surface exists; otherwise the app
  // would mount an empty xterm and call that "terminal mode".
  //
  // TODO(#484): add a provider capability for native surfaces once the
  // opencode-headless side has a parallel native-mode path with
  // screen/proxy/transcript interpretation.
  TileLeaf: TileLeaf as ComponentType<TileLeafProps>,
}

const rendererProviders: Record<AgentProviderKind, RendererProviderConfig> = {
  claude: claudeRenderer,
  codex: codexRenderer,
  opencode: opencodeRenderer,
}

export function getRendererProvider(id: string): RendererProviderConfig {
  // Validate untrusted kind (persisted SessionMeta.kind, IPC) before indexing.
  if (!isAgentProviderKind(id)) throw new Error(`Unknown provider: ${id}`)
  return rendererProviders[id]
}
