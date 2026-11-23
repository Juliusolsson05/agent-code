import { defineRenderShapeCatalog } from '@renderer/rendering/evidence/defineRenderShape'

// Antigravity render-shape catalog (#1177).
//
// EMPTY on purpose, and registered anyway — see the Grok catalog for why an
// honest empty catalog beats an absent one: an absent provider is invisible to
// the Unknown Shape Inbox. The first reviewed capture of an agy tool row adds
// the first entry here.
export const ANTIGRAVITY_RENDER_SHAPES = defineRenderShapeCatalog('antigravity', {})

export type AntigravityRenderShapeId = keyof typeof ANTIGRAVITY_RENDER_SHAPES
