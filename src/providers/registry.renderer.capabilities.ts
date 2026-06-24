import type { ReactNode } from 'react'
import type { ConditionView } from '@shared/conditions-core/view'
import type { ToolResultBlock, ToolUseBlock } from '@shared/types/transcript'
import { CLAUDE_VIEWS } from '@providers/claude/renderer/conditions/views'
import { CODEX_VIEWS } from '@providers/codex/renderer/conditions/views'
import {
  renderClaudeToolResult,
  renderClaudeToolUse,
} from '@providers/claude/renderer/rows/dispatch'
import {
  renderCodexToolResult,
  renderCodexToolUse,
} from '@providers/codex/renderer/rows/dispatch'

export type RendererProviderCapabilities = {
  id: string
  name: string
  conditionViews: Record<string, ConditionView>
  renderToolUse?: (block: ToolUseBlock) => ReactNode | undefined
  renderToolResult?: (
    block: ToolResultBlock,
    context: { sourceTool?: ToolUseBlock | null },
  ) => ReactNode | undefined
}

const claudeCapabilities: RendererProviderCapabilities = {
  id: 'claude',
  name: 'Claude Code',
  conditionViews: CLAUDE_VIEWS,
  renderToolUse: renderClaudeToolUse,
  renderToolResult: renderClaudeToolResult,
}

const codexCapabilities: RendererProviderCapabilities = {
  id: 'codex',
  name: 'Codex',
  conditionViews: CODEX_VIEWS,
  renderToolUse: renderCodexToolUse,
  renderToolResult: renderCodexToolResult,
}

const rendererProviderCapabilities: Record<string, RendererProviderCapabilities> = {
  claude: claudeCapabilities,
  codex: codexCapabilities,
}

export function getRendererProviderCapabilities(id: string): RendererProviderCapabilities {
  // WHY this file exists separately from registry.renderer.ts:
  // feed rows need provider row dispatch, but registry.renderer.ts also imports
  // TileLeaf so TileTree can mount panes. Feed -> registry.renderer -> TileLeaf
  // -> Feed is a runtime cycle. This capability-only registry contains the
  // provider renderer tables that do not need TileLeaf, so hot feed paths can
  // route through provider-owned dispatch without depending on pane mounting.
  const provider = rendererProviderCapabilities[id]
  if (!provider) throw new Error(`Unknown provider: ${id}`)
  return provider
}
