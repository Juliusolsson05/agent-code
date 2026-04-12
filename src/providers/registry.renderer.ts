// Renderer-side provider registry — browser-safe, no Node imports.
//
// TileTree and workspaceStore import from HERE, not from registry.ts.
// This file only imports renderer configs which contain TileLeaf
// components and parser functions — no session factories, no fs, no pty.

import type { RendererProviderConfig } from '../shared/types/providerConfig'
import { extractAssistantInProgress as claudeExtract } from './claude/parsers/streamingScreen'
import { extractCodexAssistantInProgress as codexExtract } from './codex/parsers/streamingScreen'
import { TileLeaf } from '../renderer/src/tiles/TileLeaf'
import type { TileLeafProps } from '../shared/types/providerConfig'

const claudeRenderer: RendererProviderConfig = {
  id: 'claude',
  name: 'Claude Code',
  extractAssistantInProgress: claudeExtract,
  TileLeaf: TileLeaf as React.ComponentType<TileLeafProps>,
}

const codexRenderer: RendererProviderConfig = {
  id: 'codex',
  name: 'Codex',
  extractAssistantInProgress: codexExtract,
  TileLeaf: TileLeaf as React.ComponentType<TileLeafProps>,
}

const rendererProviders: Record<string, RendererProviderConfig> = {
  claude: claudeRenderer,
  codex: codexRenderer,
}

export function getRendererProvider(id: string): RendererProviderConfig {
  const p = rendererProviders[id]
  if (!p) throw new Error(`Unknown provider: ${id}`)
  return p
}

export function getAllRendererProviders(): RendererProviderConfig[] {
  return Object.values(rendererProviders)
}
