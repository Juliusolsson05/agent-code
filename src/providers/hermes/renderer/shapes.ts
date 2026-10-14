import { defineRenderShapeCatalog } from '@renderer/rendering/evidence/defineRenderShape'

// No provider-specific render shapes yet: Hermes rows render through the chat
// surface (features/hermes-chat) and the shared generic rows elsewhere.
export const HERMES_RENDER_SHAPES = defineRenderShapeCatalog('hermes', {})
export type HermesRenderShapeId = keyof typeof HERMES_RENDER_SHAPES
