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
const rendererProviders: Record<AgentProviderKind, RendererProviderConfig> = {
  claude: claudeRenderer,
  codex: codexRenderer,
}

export function getRendererProvider(id: string): RendererProviderConfig {
  // Validate untrusted kind (persisted SessionMeta.kind, IPC) before indexing.
  if (!isAgentProviderKind(id)) throw new Error(`Unknown provider: ${id}`)
  return rendererProviders[id]
}
