import type { RenderShapeDefinition } from '@renderer/rendering/evidence/defineRenderShape'
import { CLAUDE_RENDER_SHAPES } from '@providers/claude/renderer/shapes'
import { CODEX_RENDER_SHAPES } from '@providers/codex/renderer/shapes'
import { OPENCODE_RENDER_SHAPES } from '@providers/opencode/renderer/shapes'

// Registry-level aggregation of the per-provider shape catalogs (Phase 3/4,
// PR #555). Importing all three providers here is what registries do —
// exactly like registry.renderer.capabilities.ts — and is legal under the
// import-boundary rules (they forbid provider→provider and shared→provider,
// not registry→provider). Consumers (the Unknown Shape Inbox, the coverage
// test, the audit script's tsx core) take the aggregate so they never
// import a provider directly.
export const ALL_RENDER_SHAPE_CATALOGS: readonly Readonly<
  Record<string, RenderShapeDefinition>
>[] = [CLAUDE_RENDER_SHAPES, CODEX_RENDER_SHAPES, OPENCODE_RENDER_SHAPES]

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
