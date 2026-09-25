import type { AgentProviderKind } from '@shared/types/providerKind'
import type { RenderShapeDefinition } from '@renderer/rendering/evidence/defineRenderShape'
import { CLAUDE_RENDER_SHAPES } from '@providers/claude/renderer/shapes'
import { CODEX_RENDER_SHAPES } from '@providers/codex/renderer/shapes'
import { OPENCODE_RENDER_SHAPES } from '@providers/opencode/renderer/shapes'
import { GROK_RENDER_SHAPES } from '@providers/grok/renderer/shapes'
import { PI_RENDER_SHAPES } from '@providers/pi/renderer/shapes'

// Registry-level aggregation of the per-provider shape catalogs (Phase 3/4,
// PR #555). Importing every provider here is what registries do —
// exactly like registry.renderer.capabilities.ts — and is legal under the
// import-boundary rules (they forbid provider→provider and shared→provider,
// not registry→provider). Consumers (the Unknown Shape Inbox, the coverage
// test, the audit script's tsx core) take the aggregate so they never
// import a provider directly.
//
// Keyed by provider kind and typed as a full Record (#1177): Grok and Pi
// shipped without catalogs and were simply missing from a plain array, which
// nothing noticed. A new provider kind now fails to compile until it names a
// catalog here, even an empty one.
const RENDER_SHAPE_CATALOGS_BY_PROVIDER: Record<AgentProviderKind, Readonly<Record<string, RenderShapeDefinition>>> = {
  claude: CLAUDE_RENDER_SHAPES,
  codex: CODEX_RENDER_SHAPES,
  opencode: OPENCODE_RENDER_SHAPES,
  grok: GROK_RENDER_SHAPES,
  pi: PI_RENDER_SHAPES,
}

export const ALL_RENDER_SHAPE_CATALOGS: readonly Readonly<
  Record<string, RenderShapeDefinition>
>[] = Object.values(RENDER_SHAPE_CATALOGS_BY_PROVIDER)

export function resolveRenderShapeDefinition(input: {
  provider: string
  fingerprint: string
  plane: string
  eventType: string
  lifecycle: string
}): RenderShapeDefinition | null {
  // Catalog sizes are deliberately small and this path runs only while dev
  // capture is armed. A direct reviewed scan keeps the lookup tied to all
  // identity dimensions; a fingerprint-only global map would let malformed
  // metadata borrow a valid shape id from the wrong provider/plane.
  for (const catalog of ALL_RENDER_SHAPE_CATALOGS) {
    for (const definition of Object.values(catalog)) {
      if (
        definition.provider === input.provider &&
        definition.fingerprints.includes(input.fingerprint) &&
        definition.planes.includes(input.plane as never) &&
        definition.eventTypes.includes(input.eventType) &&
        definition.lifecycles.includes(input.lifecycle as never)
      ) return definition
    }
  }
  return null
}
