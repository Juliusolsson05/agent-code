import type { RenderOutcomeRoute } from '@shared/types/renderShapes'

// Small route constructors keep paint call sites readable without smuggling
// catalog identity into them. The observer resolves shapeId independently
// from structural evidence; renderers may only report the owner/protocol they
// actually selected. That separation prevents a renderer from blessing its
// own payload as a reviewed catalog shape.

export function specializedOutcome(rendererId: string, protocolId?: string): RenderOutcomeRoute {
  return { kind: 'specialized', rendererId, ...(protocolId ? { protocolId } : {}) }
}

export const GENERIC_OUTCOME: RenderOutcomeRoute = {
  kind: 'generic',
  rendererId: 'shared.generic-tool',
}

export function absorbedOutcome(
  ownerRenderId: string,
  reason: string,
  protocolId?: string,
): RenderOutcomeRoute {
  return { kind: 'absorbed', ownerRenderId, reason, ...(protocolId ? { protocolId } : {}) }
}

export function unknownOutcome(fallbackRenderId: string): RenderOutcomeRoute {
  return { kind: 'unknown', fallbackRenderId }
}
