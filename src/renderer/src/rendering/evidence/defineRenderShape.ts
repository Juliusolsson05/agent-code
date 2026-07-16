import type { AgentProviderKind } from '@shared/types/providerKind'
import type {
  RenderShapeDisposition,
  RenderShapeLifecycle,
  RenderShapePlane,
} from '@shared/types/renderShapes'

// ---------------------------------------------------------------------------
// Typed shape-catalog declaration (Phase 1, plan §Step 8).
//
// This is the useful version of the requested "base definition they all
// inherit": shared compile-time metadata and coverage obligations — id
// discipline, fixture references, disposition, provenance — WITHOUT React
// inheritance, without a match()/render() function, and without a shared
// parser. Runtime interpretation stays ordinary explicit provider code that
// can be reviewed independently of catalog metadata; the catalog records
// what exists and what we promised to do with it, nothing more.
//
// WHY renderer-local (not src/shared/types/): catalogs are reviewed source
// consumed by the renderer's dispatch/coverage tests only. They never cross
// IPC — the sighting types that do live in @shared/types/renderShapes.
//
// WHY `as const satisfies RenderShapeCatalog<P>` + keyof typeof, not a
// generated union (explicit plan non-goal): the checked literal gives the
// same compile-time id safety with zero build tooling, and splitting
// shapes.ts into shapes/ later is a mechanical change that keeps `keyof
// typeof` working. A generator would be a second source of truth to drift.
// ---------------------------------------------------------------------------

/**
 * One catalogued raw shape.
 *
 * `Id extends `${P}.${string}`` makes a provider-prefix mistake (a codex id
 * inside Claude's catalog) a COMPILE error — the exact class of "future
 * agent files evidence in the wrong provider" mistake the plan wants the
 * type system to catch, not review.
 *
 * `fingerprints` is plural on purpose: one semantic shape may carry several
 * structural fingerprints across provider versions (the plan's condition
 * example — one kind, many wire layouts). Split into two entries only when
 * the VISUAL interpretation or lifecycle truly differs.
 *
 * `observed` is provenance, not decoration: upstream CLIs regress, and
 * knowing which versions/models actually emitted a shape is what makes a
 * "this stopped rendering after the CLI update" report diagnosable from the
 * repo alone. Dates are ISO `YYYY-MM-DD` strings — human-diffable in review.
 *
 * `why` is mandatory. Two similar shapes that intentionally differ, or an
 * absorbed shape whose hiding is safe, are decisions future agents must not
 * re-derive from prose archaeology — that re-derivation loop is the whole
 * disease this system cures.
 */
export type RenderShapeDefinition<
  P extends AgentProviderKind = AgentProviderKind,
  Id extends `${P}.${string}` = `${P}.${string}`,
> = {
  id: Id
  provider: P
  fingerprints: readonly string[]
  eventTypes: readonly string[]
  planes: readonly RenderShapePlane[]
  lifecycles: readonly RenderShapeLifecycle[]
  observed: {
    providerVersions: readonly string[]
    models: readonly string[]
    firstSeen: string
    lastSeen: string
  }
  fixtures: {
    final: readonly string[]
    prefixes: readonly string[]
  }
  disposition: RenderShapeDisposition
  why: string
}

/** Identity helper so a single definition gets full inference + checking
 *  without annotating both type parameters by hand. */
export function defineRenderShape<
  P extends AgentProviderKind,
  Id extends `${P}.${string}`,
>(definition: RenderShapeDefinition<P, Id>): RenderShapeDefinition<P, Id> {
  return definition
}

/**
 * A provider catalog: record keyed by shape id. Used as the `satisfies`
 * target for the per-provider `shapes.ts` literal:
 *
 *   export const CODEX_RENDER_SHAPES = { ... } as const satisfies
 *     RenderShapeCatalog<'codex'>
 *   export type CodexRenderShapeId = keyof typeof CODEX_RENDER_SHAPES
 *
 * Key↔id equality cannot be expressed by this alias alone — that is what
 * `defineRenderShapeCatalog` (compile-time) and `auditRenderShapeCatalog`
 * (runtime, catalogCoverage.ts) enforce.
 */
export type RenderShapeCatalog<P extends AgentProviderKind = AgentProviderKind> = Record<
  `${P}.${string}`,
  RenderShapeDefinition<P>
>

/**
 * Catalog constructor that makes key↔id mismatches a compile error: each
 * entry's `id` type is pinned to its own record key. Prefer this over a bare
 * `satisfies` when defining a catalog — the bare form still catches provider
 * prefixes but lets `'claude.edit': { id: 'claude.write', … }` through.
 */
export function defineRenderShapeCatalog<
  P extends AgentProviderKind,
  T extends { [K in keyof T]: K extends `${P}.${string}` ? RenderShapeDefinition<P, K & `${P}.${string}`> : never },
>(provider: P, catalog: T): T {
  // Runtime belt for the one thing the mapped type cannot see across a
  // spread/computed literal: an entry whose runtime id/provider disagrees
  // with its key. Throwing at module-eval time turns a bad catalog into a
  // test-suite failure on every run instead of a silently unclaimable shape.
  for (const [key, def] of Object.entries(catalog) as [string, RenderShapeDefinition][]) {
    if (def.id !== key) {
      throw new Error(
        `Render shape catalog key "${key}" declares id "${def.id}" — key and id must be identical`,
      )
    }
    if (def.provider !== provider) {
      throw new Error(
        `Render shape "${key}" declares provider "${def.provider}" inside the "${provider}" catalog`,
      )
    }
  }
  return catalog
}
