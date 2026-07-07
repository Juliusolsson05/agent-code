import { AGENT_PROVIDER_KINDS } from '@shared/types/providerKind'
import { getRendererProviderCapabilities } from '@providers/registry.renderer.capabilities'

// Shared predicate: does this tool_use spawn a subagent the fleet row
// should own? (Residue plan P2c — the 2026-06-21 dispatch-name blind
// spot: a session spawning via the built-in MCP orchestration server
// painted ZERO Task cards while state-snapshot.subAgents held 73 tracked
// children, because the interception only knew 'Agent'/'spawn_agent'.)
//
// This is now a THIN DELEGATOR over the renderer capability registry: the
// per-provider spawn vocabulary (claude: 'Agent' + mcp orchestration form;
// codex: 'spawn_agent' + bare orchestration form; opencode: none) lives on
// each provider's RendererProviderCapabilities.isSpawnTool, next to the rest
// of that provider's "which name means what" knowledge (#394). It used to be
// a hardcoded name Set duplicated here.
//
// WHY union across ALL providers instead of resolving the caller's provider:
// the two call sites differ. Block.tsx has the ProviderContext, but
// ConversationRow.tsx's grouping walk (isAgentBlock) does not thread a
// provider. A provider-agnostic union preserves the previous behavior EXACTLY
// — the old Set matched any of the three names regardless of provider — while
// still sourcing the names from the registry. Because each provider's spawn
// names are disjoint in practice (no backend emits another's spawn verb), the
// union is identical to a per-provider check for any real transcript.
export function isAgentSpawnToolName(name: string): boolean {
  return AGENT_PROVIDER_KINDS.some(kind =>
    getRendererProviderCapabilities(kind).isSpawnTool(name),
  )
}
