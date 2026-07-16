import type { RenderOutcome } from '@shared/types/renderShapes'

// Paint-outcome helpers — Phase 2. One-liners so the observation call sites
// in the legacy painter stay single-line and uniform.
//
// PRE-RECEIPT ERA HONESTY: until Phase 5's ProviderOperationBoundary emits
// catalog-backed receipts, the legacy painter cannot name a catalogued
// shapeId at paint time. `specialized` outcomes therefore carry the
// RENDERER id in both slots — classifySighting only matches dispositions on
// rendererId, so the placeholder shapeId is inert for coverage, and the
// Phase 5 receipt system replaces these helpers' call sites wholesale.

export function specializedOutcome(rendererId: string): RenderOutcome {
  return { kind: 'specialized', shapeId: rendererId, rendererId }
}

export const GENERIC_OUTCOME: RenderOutcome = {
  kind: 'generic',
  rendererId: 'shared.generic-tool',
}

export function absorbedOutcome(ownerRenderId: string, reason: string): RenderOutcome {
  return { kind: 'absorbed', ownerRenderId, reason }
}

export function unknownOutcome(fallbackRenderId: string): RenderOutcome {
  return { kind: 'unknown', fallbackRenderId }
}
