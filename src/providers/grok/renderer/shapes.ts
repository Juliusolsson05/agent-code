import { defineRenderShapeCatalog } from '@renderer/rendering/evidence/defineRenderShape'

// Grok render-shape catalog (#1177).
//
// EMPTY on purpose, and registered anyway. Until #1177 Grok had no catalog at
// all and was missing from registry.renderShapes.ts, so its painted shapes
// could never be looked up and the Unknown Shape Inbox could not even say
// "this is a Grok shape nobody has reviewed" — the provider was invisible to
// the evidence loop rather than honestly uncatalogued. Same rule as the
// OpenCode catalog: no entry is invented from an unobserved tool list; the
// first reviewed capture through the Inbox adds the first ones here. (The
// grok-session-feed fixture exercises boundary reordering, not tool shapes.)
export const GROK_RENDER_SHAPES = defineRenderShapeCatalog('grok', {})

export type GrokRenderShapeId = keyof typeof GROK_RENDER_SHAPES
