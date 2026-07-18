import {
  fingerprintRenderShape,
  type ShapeFingerprint,
} from '@renderer/rendering/evidence/shapeFingerprint'
import type {
  RenderOutcomeRoute,
  RenderShapeLifecycle,
  RenderShapePlane,
} from '@shared/types/renderShapes'
import { asRecord } from '@shared/lib/asRecord'
import {
  committedBlockObservationDisposition,
  CONTENT_BLOCK_DRIFT_FALLBACK_RENDER_ID,
} from '@renderer/rendering/evidence/observationScope'

// Bundle → shape-observation sweep (Phase 4, PR #555).
//
// Walks one checked-in rendering bundle (testing/fixtures/rendering-bundles)
// and yields the same observations the Phase 2 runtime observer would have
// produced had capture been armed when that bundle's session ran. This is
// how the 48-bundle corpus seeds the catalogs WITHOUT waiting for new
// capture soaks — the bundles are frozen ground truth of real sessions.
//
// ONE implementation on purpose, consumed by three callers: the Phase 4
// coverage test (the "zero unclassified fingerprints" gate), the
// audit-rendering-shapes script, and the one-off seeding run that generated
// the initial catalog entries. If the sweep and the gate were separate
// walks they would drift, and a drifted gate is worse than none.
//
// The walk mirrors the runtime observation points exactly:
//   entries[].message.content[] tool_use     → committed-tool-use, durable
//   entries[].message.content[] tool_result  → committed-tool-result, durable
//   entries[].type (non-conversation)        → transcript-entry, durable
//   semanticHistory/current turn blocks      → semantic-tool,
//                                              finalized ? input-complete
//                                                        : prefix
// Exact normalized text/thinking/image envelopes are deliberately outside the
// routing catalog; known labels with novel structure and unknown labels are
// NOT. observationScope.ts is shared with Block so this fixture walk cannot
// silently skip drift that the runtime painter records.

export type BundleShapeObservation = {
  provider: string
  plane: RenderShapePlane
  lifecycle: RenderShapeLifecycle
  eventType: string
  payload: unknown
  fingerprint: ShapeFingerprint
  /** Fixture sweeps cannot infer provider tool receipts, but content drift
   *  has one honest route by construction: the known leaf paints its supported
   *  projection while no reviewed renderer claims the novel envelope. */
  outcome: RenderOutcomeRoute | null
}

export function sweepBundleShapes(bundle: unknown): BundleShapeObservation[] {
  const out: BundleShapeObservation[] = []
  const root = asRecord(bundle)
  const input = asRecord(root?.input)
  if (!input) return out
  const provider = typeof input.provider === 'string' ? input.provider : 'unknown'

  const observe = (
    plane: RenderShapePlane,
    lifecycle: RenderShapeLifecycle,
    eventType: string,
    payload: unknown,
    outcome: RenderOutcomeRoute | null = null,
  ): void => {
    out.push({
      provider,
      plane,
      lifecycle,
      eventType,
      payload,
      outcome,
      fingerprint: fingerprintRenderShape({
        provider: provider as never,
        plane,
        eventType,
        payload,
      }),
    })
  }

  const entries = Array.isArray(input.entries) ? input.entries : []
  for (const rawEntry of entries) {
    const entry = asRecord(rawEntry)
    if (!entry || typeof entry.type !== 'string') continue
    const isConversation = entry.type === 'user' || entry.type === 'assistant'
    if (!isConversation) {
      // Non-conversation entry kinds (system:*, pr-link, queue-operation:*,
      // attachment) route via EntryRow — eventType mirrors its
      // `type:subtype` convention.
      const subtype = typeof entry.subtype === 'string' ? `:${entry.subtype}` : ''
      observe('transcript-entry', 'durable', `${entry.type}${subtype}`, entry)
      continue
    }
    // PARITY with EntryRow's two conversation-typed sight branches (review
    // finding: compact-summary entries are type 'user' with a marker, and
    // task-notification carriers are user/assistant with the XML envelope —
    // EntryRow sights both on the transcript-entry plane, so the sweep must
    // fingerprint them too or real captures file them as false unknowns the
    // corpus can never close). The predicates mirror EntryRow's guards
    // structurally (marker field / notification envelope) without importing
    // renderer UI modules into this pure sweep.
    if (entry.isCompactSummary === true) {
      observe('transcript-entry', 'durable', entry.type, entry)
      continue
    }
    const message = asRecord(entry.message)
    const content = message ? message.content : null
    // Mirrors taskNotificationTextOf: string content, or the first text
    // block of array content, starting with the notification tag.
    const notificationText =
      typeof content === 'string'
        ? content
        : Array.isArray(content)
          ? ((content.find(b => asRecord(b)?.type === 'text') as { text?: unknown } | undefined)
              ?.text as string | undefined)
          : undefined
    if (
      entry.type === 'user' &&
      typeof notificationText === 'string' &&
      notificationText.trimStart().startsWith('<task-notification>')
    ) {
      observe('transcript-entry', 'durable', entry.type, entry)
      continue
    }
    if (!Array.isArray(content)) continue
    for (const rawBlock of content) {
      const block = asRecord(rawBlock)
      if (!block || typeof block.type !== 'string') continue
      const disposition = committedBlockObservationDisposition(block)
      if (disposition === 'tool-use') {
        observe('committed-tool-use', 'durable', 'tool_use', block)
      } else if (disposition === 'tool-result') {
        observe('committed-tool-result', 'durable', 'tool_result', block)
      } else if (disposition === 'unknown-block') {
        observe('transcript-entry', 'durable', block.type, block, {
          kind: 'unknown',
          fallbackRenderId: 'shared.block-type-label',
        })
      } else if (disposition === 'content-drift') {
        observe('transcript-entry', 'durable', block.type, block, {
          kind: 'unknown',
          fallbackRenderId: CONTENT_BLOCK_DRIFT_FALLBACK_RENDER_ID,
        })
      }
      // content-native: exact shared-leaf exclusion — see scope helper.
    }
  }

  const turns = [
    ...(Array.isArray(input.semanticHistory) ? input.semanticHistory : []),
    input.semanticCurrent,
  ]
  for (const rawTurn of turns) {
    const turn = asRecord(rawTurn)
    const blocks = asRecord(turn?.blocks)
    if (!blocks) continue
    for (const rawBlock of Object.values(blocks)) {
      const block = asRecord(rawBlock)
      if (!block || typeof block.kind !== 'string') continue
      observe(
        'semantic-tool',
        block.finalized === true ? 'input-complete' : 'prefix',
        block.kind,
        block,
      )
    }
  }

  return out
}

/** Sweep one curated `testing/fixtures/rendering-shapes/**` envelope.
 *
 * WHY this is separate from sweepBundleShapes: curated fixtures intentionally
 * store only the provider object(s) under test, not a fake RuntimeLedgerSlices
 * wrapper. Making them impersonate a full bundle would add invented evidence.
 * The accepted carrier keys are the fixture schema used in-tree: direct
 * toolUse/toolResult/semanticBlock fields or a `cases[]` array containing
 * those fields. Every emitted observation still goes through the canonical
 * fingerprint helper and the same painter lifecycle semantics.
 */
export function sweepCuratedShapeFixture(
  fixture: unknown,
  provider: string,
): BundleShapeObservation[] {
  const out: BundleShapeObservation[] = []
  const root = asRecord(fixture)
  if (!root) return out

  const observe = (
    plane: RenderShapePlane,
    lifecycle: RenderShapeLifecycle,
    eventType: string,
    payload: unknown,
    outcome: RenderOutcomeRoute | null = null,
  ): void => {
    out.push({
      provider,
      plane,
      lifecycle,
      eventType,
      payload,
      outcome,
      fingerprint: fingerprintRenderShape({
        provider: provider as never,
        plane,
        eventType,
        payload,
      }),
    })
  }

  const sweepCarrier = (rawCarrier: unknown): void => {
    const carrier = asRecord(rawCarrier)
    if (!carrier) return
    const toolUse = asRecord(carrier.toolUse)
    if (toolUse?.type === 'tool_use') {
      observe('committed-tool-use', 'durable', 'tool_use', toolUse)
    }
    const toolResult = asRecord(carrier.toolResult)
    if (toolResult?.type === 'tool_result') {
      observe('committed-tool-result', 'durable', 'tool_result', toolResult)
    }
    const semanticBlock = asRecord(carrier.semanticBlock)
    if (semanticBlock && typeof semanticBlock.kind === 'string') {
      // Mirrors SemanticLiveBlockRow exactly. `status:completed` affects text
      // ownership, but the evidence lifecycle closes only on finalized=true;
      // silently treating the two as synonyms would let fixtures prove a
      // lifecycle the painter never reports.
      observe(
        'semantic-tool',
        semanticBlock.finalized === true ? 'input-complete' : 'prefix',
        semanticBlock.kind,
        semanticBlock,
      )
    }
  }

  sweepCarrier(root)
  if (Array.isArray(root.cases)) {
    for (const fixtureCase of root.cases) sweepCarrier(fixtureCase)
  }
  return out
}
