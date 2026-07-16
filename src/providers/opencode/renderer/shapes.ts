import { defineRenderShapeCatalog } from '@renderer/rendering/evidence/defineRenderShape'

// OpenCode render-shape catalog (Phase 4, PR #555).
//
// DELIBERATELY EMPTY at seeding time, and that emptiness is evidence, not
// an omission: the 48-bundle corpus's three opencode bundles are all
// empty-shell fixtures (entries: [], zero blocks — they exercise streaming
// shell states, not tool shapes), so there is no observed opencode wire
// structure to catalog yet. The plan forbids inventing entries from an
// unobserved tool list ("no renderer invented from an unobserved tool
// list", Phase 4 gate). First real opencode capture soak → first entries
// land here through the Unknown Shape Inbox loop.
export const OPENCODE_RENDER_SHAPES = defineRenderShapeCatalog('opencode', {})

export type OpencodeRenderShapeId = keyof typeof OPENCODE_RENDER_SHAPES
