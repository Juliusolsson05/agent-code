#!/usr/bin/env npx tsx --tsconfig tsconfig.web.json
// Render-shape coverage audit (Phase 3/4, PR #555).
//
// Compares OBSERVED shapes against the checked-in provider catalogs and
// prints the coverage report the plan requires. Two evidence sources:
//
//   default            sweep testing/fixtures/rendering-bundles (the frozen
//                      corpus) through the SAME bundleShapeSweep the
//                      coverage test uses;
//   --recordings [dir] additionally sweep __render_shape sidecar lines from
//                      local session recordings (default:
//                      ~/.config/agent-code/session-recordings).
//
//   --seed             print suggested catalog entries for every
//                      UNCLASSIFIED fingerprint, GROUPED by (provider,
//                      plane family, discriminator slug) with all variant
//                      fingerprints merged under one id (plan: multiple
//                      fingerprints per shape id when semantics match) —
//                      the copy-paste source for shapes.ts. Prints source,
//                      never writes it: classification stays a reviewed
//                      code change (plan §Step 6).
//
// Run: npx tsx --tsconfig tsconfig.web.json scripts/audit-rendering-shapes.mts [--seed] [--recordings [dir]]
//
// Exit codes: 0 = clean; 1 = unknown-structure, unsupported-lifecycle,
// misrouted, or unknown-outcome shapes exist. Prefixes are first-class catalog
// promises now that Phase 10 has no planned entries: treating an observed but
// undeclared lifecycle as advisory would let the exact streaming regressions
// this audit exists to catch ship behind a green command.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { sweepBundleShapes } from '../src/renderer/src/rendering/evidence/bundleShapeSweep.ts'
import {
  buildFingerprintIndex,
  classifySighting,
  classifySightingStructure,
} from '../src/renderer/src/rendering/evidence/catalogCoverage.ts'
import { ALL_RENDER_SHAPE_CATALOGS } from '../src/providers/registry.renderShapes.ts'
import type { RenderOutcome, RenderShapeSighting } from '../src/shared/types/renderShapes.ts'
import {
  renderOutcomeRouteIdentity,
  renderShapeWriterKey,
} from '../src/shared/types/renderShapes.ts'

const args = process.argv.slice(2)
const SEED = args.includes('--seed')
const recIdx = args.indexOf('--recordings')
// STATE_DIR (src/main/storage/paths.ts) is electron-bound; scripts mirror the
// well-known location instead of importing it (same as
// extract-rendering-recordings.mjs).
const RECORDINGS_DIR =
  recIdx >= 0
    ? args[recIdx + 1] && !args[recIdx + 1].startsWith('--')
      ? args[recIdx + 1]
      : join(homedir(), '.config', 'agent-code', 'session-recordings')
    : null
const MAX_RECORDINGS = 200
const MAX_RECORDING_BYTES = 64 * 1024 * 1024

type Observation = {
  provider: string
  plane: string
  lifecycle: string
  eventType: string
  fingerprint: string
  shapePaths: readonly string[]
  discriminators: Readonly<Record<string, string>>
  /** Full outcome, not just kind (review finding: reconstructing {kind}
   *  dropped rendererId/ownerRenderId and made every graduated shape read
   *  as misrouted). Null for bundle observations, which predate receipts. */
  outcome: RenderOutcome | null
  count: number
}

const observations: Observation[] = []

// ---- Source 1: the frozen bundle corpus -----------------------------------
const bundleDir = join(process.cwd(), 'testing', 'fixtures', 'rendering-bundles')
for (const file of readdirSync(bundleDir).filter(f => f.endsWith('.json'))) {
  const bundle = JSON.parse(readFileSync(join(bundleDir, file), 'utf-8'))
  for (const obs of sweepBundleShapes(bundle)) {
    observations.push({
      provider: obs.provider,
      plane: obs.plane,
      lifecycle: obs.lifecycle,
      eventType: obs.eventType,
      fingerprint: obs.fingerprint.fingerprint,
      shapePaths: obs.fingerprint.shapePaths,
      discriminators: obs.fingerprint.discriminatorValues,
      outcome: null,
      count: 1,
    })
  }
}

// ---- Source 2: recording sidecars (optional) -------------------------------
if (RECORDINGS_DIR) {
  let dirs: string[] = []
  try {
    dirs = readdirSync(RECORDINGS_DIR)
  } catch {
    console.error(`no recordings dir at ${RECORDINGS_DIR} — skipping recordings sweep`)
  }
  // Writer emits a key once (implied count 1) plus a final-flush copy with
  // cumulative seenCount — MAX per writer key, never sum (review finding:
  // summing double-counted every repeated key by one).
  const maxByWriterKey = new Map<string, Observation>()
  let obsoleteReceiptSightings = 0
  // Recording directory names begin with an ISO timestamp. Readdir order is
  // filesystem-dependent; slicing it directly made two identical audits scan
  // different sessions and even let an old 200-directory window hide the
  // newest upstream drift. Sorting and taking the newest bounded window keeps
  // the command deterministic while prioritizing the evidence Phase 9 is
  // actually trying to validate.
  const selectedDirs = dirs.sort().slice(-MAX_RECORDINGS)
  for (const dir of selectedDirs) {
    let body: string
    try {
      const eventPath = join(RECORDINGS_DIR, dir, 'events.jsonl')
      // A local diagnostic should not accidentally turn one runaway recording
      // into an unbounded allocation. Skipping is explicit in the final count;
      // the recorder remains the source and can be inspected separately.
      if (statSync(eventPath).size > MAX_RECORDING_BYTES) continue
      body = readFileSync(eventPath, 'utf-8')
    } catch {
      continue
    }
    for (const line of body.split('\n')) {
      if (!line.includes('"__render_shape"')) continue
      try {
        const parsed = JSON.parse(line)
        if (parsed.ch !== '__render_shape' || !Array.isArray(parsed.sightings)) continue
        for (const s of parsed.sightings) {
          // v1 was an unreleased pre-receipt experiment: shapeId was either
          // missing or held a renderer id. Mixing it with v2 would make old
          // local recordings look like current routing failures. Report and
          // ignore it; no runtime compatibility is warranted for PR-local
          // evidence that can be recaptured.
          if (s.schemaVersion !== 2) {
            obsoleteReceiptSightings += 1
            continue
          }
          if (!s.outcome) continue
          const key = renderShapeWriterKey(s as RenderShapeSighting, dir)
          if (typeof s.seenCount !== 'number' || !Number.isFinite(s.seenCount) || s.seenCount < 1) continue
          const count = s.seenCount
          const existing = maxByWriterKey.get(key)
          if (existing && existing.count >= count) continue
          maxByWriterKey.set(key, {
            provider: s.provider,
            plane: s.sourcePlane,
            lifecycle: s.lifecycle,
            eventType: s.eventType,
            fingerprint: s.structuralFingerprint,
            shapePaths: s.shapePaths ?? [],
            discriminators: s.discriminatorValues ?? {},
            outcome: s.outcome ?? null,
            count,
          })
        }
      } catch {
        continue
      }
    }
  }
  observations.push(...maxByWriterKey.values())
  if (obsoleteReceiptSightings > 0) {
    console.error(`ignored ${obsoleteReceiptSightings} obsolete v1 receipt sightings; capture a fresh v2 soak`)
  }
}

// ---- Classify ---------------------------------------------------------------
const index = buildFingerprintIndex(ALL_RENDER_SHAPE_CATALOGS)
const byStatus = new Map<string, Map<string, Observation[]>>()
for (const obs of observations) {
  // Bundle observations predate receipts. Missing evidence is not evidence of
  // a generic route: classify only structure/lifecycle and report the outcome
  // as unobserved. Recording sidecars do carry receipts and therefore take the
  // strict full-outcome path below.
  const classification = obs.outcome
    ? classifySighting(
        {
          structuralFingerprint: obs.fingerprint,
          lifecycle: obs.lifecycle as never,
          outcome: obs.outcome,
        },
        index,
      )
    : (() => {
        const structure = classifySightingStructure(
          {
            structuralFingerprint: obs.fingerprint,
            lifecycle: obs.lifecycle as never,
          },
          index,
        )
        return structure.kind === 'known-structure'
          ? { kind: 'known-outcome-unobserved' as const, shapeId: structure.shapeId }
          : structure
      })()
  const status = byStatus.get(classification.kind) ?? new Map<string, Observation[]>()
  const group = status.get(`${obs.provider} ${obs.fingerprint}`) ?? []
  group.push(obs)
  status.set(`${obs.provider} ${obs.fingerprint}`, group)
  byStatus.set(classification.kind, status)
}

const summary = [...byStatus.entries()]
  .map(
    ([status, groups]) =>
      `${status}: ${groups.size} shapes / ${[...groups.values()].reduce((n, g) => n + g.reduce((m, o) => m + o.count, 0), 0)} sightings`,
  )
  .join('\n')
console.log(`observations: ${observations.length}\n${summary}\n`)

// WHY fatal groups are printed instead of leaving only the aggregate count:
// Phase 9 uses this command as the local unknown-shape inbox. A report saying
// merely "one misroute" forces the developer to reimplement this join over
// events.jsonl just to learn which catalog promise is wrong—the exact evidence
// archaeology this script exists to remove. Paths stay bounded because the
// observer already caps them, and outcomes contain route ids rather than raw
// provider content.
for (const kind of [
  'unknown-structure',
  'known-unsupported-lifecycle',
  'known-misrouted',
  'unknown-outcome',
] as const) {
  const groups = byStatus.get(kind)
  if (!groups || groups.size === 0) continue
  console.log(`${kind} details:`)
  for (const [key, group] of groups) {
    const outcomes = [...new Set(group.flatMap(observation =>
      observation.outcome ? [renderOutcomeRouteIdentity(observation.outcome)] : [],
    ))].sort()
    const example = group[0]
    console.log(
      `  ${key} lifecycle=${example.lifecycle}` +
      `${outcomes.length > 0 ? ` outcomes=${outcomes.join(',')}` : ''}` +
      `${example.shapePaths.length > 0 ? ` paths=${example.shapePaths.slice(0, 8).join(' ')}` : ''}`,
    )
  }
  console.log('')
}

// ---- Seed mode --------------------------------------------------------------
if (SEED) {
  const unknown = byStatus.get('unknown-structure') ?? new Map<string, Observation[]>()
  type SeedGroup = {
    provider: string
    family: string
    slug: string
    fingerprints: Set<string>
    eventTypes: Set<string>
    planes: Set<string>
    lifecycles: Set<string>
    count: number
    samplePaths: readonly string[]
  }
  const seedGroups = new Map<string, SeedGroup>()
  for (const group of unknown.values()) {
    for (const obs of group) {
      const family =
        obs.plane === 'committed-tool-use'
          ? 'tool-use'
          : obs.plane === 'committed-tool-result'
            ? 'tool-result'
            : obs.plane === 'semantic-tool'
              ? 'semantic'
              : obs.plane === 'condition'
                ? 'condition'
                : 'entry'
      // Discriminator preference mirrors what selects the visual grammar:
      // tool name first, then the provider result-kind (codex.kind), then
      // any structural kind/type, then the event type.
      const d = obs.discriminators
      const disc =
        d['name'] ?? d['toolName'] ?? d['codex.kind'] ?? d['kind'] ?? d['type'] ?? obs.eventType
      const slug = String(disc)
        .toLowerCase()
        .replace(/^mcp__.*__orchestration_/, 'mcp-orchestration-')
        .replace(/^mcp__.*__/, 'mcp-')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
      const key = `${obs.provider}|${family}|${slug}`
      const g =
        seedGroups.get(key) ??
        ({
          provider: obs.provider,
          family,
          slug,
          fingerprints: new Set<string>(),
          eventTypes: new Set<string>(),
          planes: new Set<string>(),
          lifecycles: new Set<string>(),
          count: 0,
          samplePaths: obs.shapePaths,
        } satisfies SeedGroup)
      g.fingerprints.add(obs.fingerprint)
      g.eventTypes.add(obs.eventType)
      g.planes.add(obs.plane)
      g.lifecycles.add(obs.lifecycle)
      g.count += obs.count
      seedGroups.set(key, g)
    }
  }
  const today = new Date().toISOString().slice(0, 10)
  for (const g of [...seedGroups.values()].sort((a, b) =>
    `${a.provider}.${a.family}.${a.slug}`.localeCompare(`${b.provider}.${b.family}.${b.slug}`),
  )) {
    const id = `${g.provider}.${g.family}.${g.slug}.v1`
    console.log(`  // ${g.count} sightings — paths: ${g.samplePaths.slice(0, 10).join(' ')}`)
    console.log(`  '${id}': defineRenderShape({`)
    console.log(`    id: '${id}',`)
    console.log(`    provider: '${g.provider}',`)
    console.log(`    fingerprints: ${JSON.stringify([...g.fingerprints].sort())},`)
    console.log(`    eventTypes: ${JSON.stringify([...g.eventTypes].sort())},`)
    console.log(`    planes: ${JSON.stringify([...g.planes].sort())} as const,`)
    console.log(`    lifecycles: ${JSON.stringify([...g.lifecycles].sort())} as const,`)
    console.log(`    observed: { providerVersions: [], models: [], firstSeen: '${today}', lastSeen: '${today}' },`)
    console.log(`    fixtures: { final: [], prefixes: [] },`)
    console.log(`    disposition: { kind: 'planned', targetGrammar: 'structured-tool' },`)
    console.log(`    why: 'Seeded from observed sightings (${g.count}); REVIEW: set targetGrammar + fixtures.',`)
    console.log(`  }),\n`)
  }
}

const fatal =
  (byStatus.get('unknown-structure')?.size ?? 0) +
  (byStatus.get('known-unsupported-lifecycle')?.size ?? 0) +
  (byStatus.get('known-misrouted')?.size ?? 0) +
  (byStatus.get('unknown-outcome')?.size ?? 0)
process.exit(fatal > 0 ? 1 : 0)
