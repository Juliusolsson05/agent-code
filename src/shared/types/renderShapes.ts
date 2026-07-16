import type { AgentProviderKind } from '@shared/types/providerKind'

// ---------------------------------------------------------------------------
// Render-shape evidence contracts (evidence-first feed rendering, Phase 1).
//
// Plan of record: docs/superpowers/plans/2026-07-16-evidence-first-provider-
// owned-feed-rendering{,-lean}.md (PR #554). These types are the wire-level
// vocabulary for the shape-memory system: the renderer observes every
// distinctive provider structure it is about to paint, fingerprints it
// WITHOUT content, and (in Phase 2) ships coalesced sightings across IPC into
// the session recording as `__render_shape` sidecar lines.
//
// WHY this lives in src/shared/types/ and not the renderer: the sighting
// crosses three worlds — renderer (observer), preload (dev-gated API), main
// (SessionRecorder sidecar). One serializable contract shared by all three
// prevents the preload/main copies from drifting the way duplicated decoders
// drifted in the old painter. The catalog-definition types deliberately do
// NOT live here: catalogs are renderer-only reviewed source
// (rendering/evidence/defineRenderShape.ts) and never cross IPC.
//
// THE PRIVACY INVARIANT (non-negotiable, tested in shapeFingerprint.test.ts):
// nothing in this file may ever carry a prompt, command, file path, assistant
// text, tool argument/output value, or condition option text. Sightings are
// METADATA ONLY. `payloadHash` is the single deliberate exception — it is
// content-SENSITIVE (a hash of the full payload) but not content-REVEALING,
// kept purely as a local dedup/sample identity. It must never become the
// catalog key: hashing content would turn every distinct command or prompt
// into a supposedly new shape (the exact failure the structural fingerprint
// exists to avoid).
// ---------------------------------------------------------------------------

/**
 * Where in the pipeline the observer saw the value. These are the four
 * renderer-facing planes from the plan (§Step 2) — note they are NOT the
 * ledger's `RenderSourcePlane` (committed/semantic/ghost/…): that enum
 * answers "which ingest plane produced a candidate", this one answers "what
 * kind of value was the painter about to interpret". Committed tool use and
 * result are split because their wire structures differ per provider and a
 * result can arrive without its use (and vice versa) — collapsing them was
 * one source of the old duplicate-decoder mess.
 */
export type RenderShapePlane =
  | 'committed-tool-use'
  | 'committed-tool-result'
  | 'semantic-tool'
  | 'transcript-entry'
  | 'condition'

/**
 * How far along the operation was when observed. `prefix` is first-class
 * because meaningful streaming prefixes (a partial apply_patch wrapper, a
 * half-streamed Edit input) are exactly the shapes the old renderer kept
 * forgetting — a component that only handles the complete shape regresses
 * the moment input streams. `durable` marks transcript/replay evidence that
 * survives restart (vs the live lifecycle states that precede it).
 */
export type RenderShapeLifecycle =
  | 'prefix'
  | 'input-complete'
  | 'running'
  | 'result-complete'
  | 'durable'

/**
 * What the painter actually did with the value — recorded as a receipt so
 * the Unknown Shape Inbox can distinguish "catalogued and correctly claimed"
 * from "catalogued but misrouted". There is deliberately no silent-null arm:
 * per the plan's total-paint-accountability rule, every observation ends in
 * one of these five outcomes. `absorbed` must name the owning render id —
 * hiding is the most dangerous operation in the renderer, and an absorption
 * without a named owner is indistinguishable from a vanish bug (#469 class).
 */
export type RenderOutcome =
  | {
      kind: 'specialized'
      shapeId: string
      rendererId: string
      protocolId?: string
    }
  | {
      kind: 'generic'
      shapeId?: string
      rendererId: 'shared.generic-tool'
    }
  | {
      kind: 'absorbed'
      shapeId?: string
      ownerRenderId: string
      reason: string
    }
  | {
      kind: 'condition-surface'
      shapeId: string
      surface: 'outlet' | 'feed-inline' | 'composer' | 'attention-only'
    }
  | {
      kind: 'unknown'
      fallbackRenderId: string
    }

/**
 * One metadata-only observation of a renderer-facing structure.
 *
 * `structuralFingerprint` is the shape's identity: derived from key/type
 * paths + a small discriminator allowlist, never from content (see
 * rendering/evidence/shapeFingerprint.ts for the exact recipe and its WHY).
 * `shapePaths` and `discriminatorValues` are carried alongside so a human
 * reading the inbox can tell WHAT structure the fingerprint denotes without
 * re-running the payload through the helper.
 *
 * `sourceRecordingCursor` links the sighting back to the full session
 * recording (which retains the real payload under its existing local-only
 * privacy model) — that link is what lets `extract-rendering-shape.mjs`
 * turn a sighting into a redacted fixture without transcript archaeology.
 *
 * `providerVersion`/`model` are provenance, not identity: upstream CLIs
 * regress and default unexpectedly, so knowing WHICH versions emitted a
 * shape is evidence. Missing provenance is `null` ("unknown"), never
 * inferred from content (plan open decision #2).
 */
export type RenderShapeSighting = {
  schemaVersion: 1
  sessionId: string
  provider: AgentProviderKind | 'unknown'
  providerVersion: string | null
  model: string | null
  sourcePlane: RenderShapePlane
  lifecycle: RenderShapeLifecycle
  eventType: string
  structuralFingerprint: string
  shapePaths: readonly string[]
  discriminatorValues: Readonly<Record<string, string>>
  payloadHash: string
  sourceRecordingCursor: number | null
  observedAt: number
  outcome: RenderOutcome
  /**
   * How many times this exact (provider, plane, lifecycle, eventType,
   * fingerprint, outcome-kind) key was observed since capture began. Only
   * meaningful on the FINAL-FLUSH copy of a sighting: the live path emits a
   * key once on first sight (count 1 implied) and counts repeats locally —
   * shipping a message per repeat is the IPC flood the observer exists to
   * prevent. The disarm flush re-emits keys whose count grew so the sidecar
   * records the true volume.
   */
  seenCount?: number
}

/**
 * The reviewed classification a developer assigns to a catalogued shape
 * (plan §Step 6). Classification is a CODE CHANGE — these values live in
 * checked-in provider catalogs, never mutated at runtime.
 *
 * - `absorbed` requires the owning renderer id (and, by convention enforced
 *   in catalog audits, a fixture proving the useful result stays visible).
 * - `unsupported` still paints a visible fallback — it means "no
 *   specialization promised", never "row disappears".
 * - `planned` names the target grammar so the inbox can show intent instead
 *   of reading as unfinished work.
 */
export type RenderShapeDisposition =
  | {
      kind: 'specialized'
      rendererId: string
      protocolId?: string
    }
  | {
      kind: 'generic'
      rendererId: 'shared.generic-tool'
      reason: string
    }
  | {
      kind: 'absorbed'
      ownerRendererId: string
      reason: string
    }
  | {
      kind: 'condition-surface'
      surface: 'outlet' | 'feed-inline' | 'composer' | 'attention-only'
    }
  | {
      kind: 'planned'
      targetGrammar: string
    }
  | {
      kind: 'unsupported'
      reason: string
    }
