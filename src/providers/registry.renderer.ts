// Renderer-side provider registry — browser-safe, no Node imports.
//
// TileTree and workspaceStore import from HERE, not from registry.ts.
// This file only imports renderer configs which contain TileLeaf
// components and parser functions — no session factories, no fs, no pty.

import type { RendererProviderConfig } from '../shared/types/providerConfig'
// Import parser functions by direct file path — NOT through the package
// entry point. The headless packages pull in Node deps (pty, fs) through
// their main export, but the parser files are pure TypeScript (no Node,
// no DOM). Direct imports keep the renderer bundle browser-safe.
import { extractAssistantInProgress as claudeExtract } from '../shared/parsers/claudeScreen'
import { extractCodexAssistantInProgress as codexExtract } from '../shared/parsers/codexScreen'
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
