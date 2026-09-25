import { defineRenderShapeCatalog } from '@renderer/rendering/evidence/defineRenderShape'

// Pi render-shape catalog (#1177).
//
// EMPTY on purpose, and registered anyway — see the Grok catalog for why an
// honest empty catalog beats an absent one: an absent provider was invisible
// to the Unknown Shape Inbox. Pi has only fake-model evidence so far, and no
// entry is invented from an unobserved tool list; the first reviewed real
// capture adds the first ones here.
export const PI_RENDER_SHAPES = defineRenderShapeCatalog('pi', {})

export type PiRenderShapeId = keyof typeof PI_RENDER_SHAPES
