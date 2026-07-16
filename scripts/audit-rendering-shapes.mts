#!/usr/bin/env npx tsx --tsconfig tsconfig.web.json
// Render-shape coverage audit (Phase 3/4, PR #555).
//
// Compares OBSERVED shapes against the checked-in provider catalogs and
// prints the coverage report the plan requires (total / known / misrouted /
// unsupported-lifecycle / unknown / unknown-outcome). Two evidence sources:
//
//   default            sweep testing/fixtures/rendering-bundles (the frozen
//                      48-bundle corpus) through the SAME
//                      bundleShapeSweep the coverage test uses;
//   --recordings [dir] additionally sweep __render_shape sidecar lines from
//                      local session recordings (default:
//                      ~/.config/agent-code/session-recordings).
//
//   --seed             print suggested catalog entries for every
//                      UNCLASSIFIED fingerprint, grouped by provider +
//                      discriminator — the copy-paste source for
//                      shapes.ts. Seeding stays a reviewed code change
//                      (plan §Step 6): this prints source text, it never
//                      writes source files.
//
// Run: npx tsx --tsconfig tsconfig.web.json scripts/audit-rendering-shapes.mts [--seed] [--recordings [dir]]
//
// Exit codes: 0 = full coverage; 1 = unclassified/misrouted shapes exist.
// CI-friendly by design, but the authoritative CI gate is the in-repo
// coverage test (shapes.coverage.test.ts) — this script exists for local
// triage and for sweeping recordings, which CI does not have.

import { readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { sweepBundleShapes } from '../src/renderer/src/rendering/evidence/bundleShapeSweep.ts'
import {
  buildFingerprintIndex,
  classifySighting,
} from '../src/renderer/src/rendering/evidence/catalogCoverage.ts'
import { ALL_RENDER_SHAPE_CATALOGS } from '../src/providers/registry.renderShapes.ts'

const args = process.argv.slice(2)
const SEED = args.includes('--seed')
const recIdx = args.indexOf('--recordings')
// STATE_DIR (src/main/storage/paths.ts) is electron-bound; scripts mirror the
// well-known location instead of importing it. If the app's state dir moves,
// this default (and extract-rendering-recordings.mjs) move with it.
const RECORDINGS_DIR =
  recIdx >= 0
    ? args[recIdx + 1] && !args[recIdx + 1].startsWith('--')
      ? args[recIdx + 1]
      : join(homedir(), '.config', 'agent-code', 'session-recordings')
    : null

type Observation = {
  provider: string
  plane: string
  lifecycle: string
  eventType: string
  fingerprint: string
  shapePaths: readonly string[]
  discriminators: Readonly<Record<string, string>>
  outcomeKind: string | null
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
      outcomeKind: null, // bundles predate outcome receipts
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
    console.error(`no recordings dir at ${RECORDINGS_DIR} — skipping`)
  }
  for (const dir of dirs) {
    let body: string
    try {
      body = readFileSync(join(RECORDINGS_DIR, dir, 'events.jsonl'), 'utf-8')
    } catch {
      continue
    }
    for (const line of body.split('\n')) {
      if (!line.includes('"__render_shape"')) continue
      try {
        const parsed = JSON.parse(line)
        if (parsed.ch !== '__render_shape' || !Array.isArray(parsed.sightings)) continue
        for (const s of parsed.sightings) {
          observations.push({
            provider: s.provider,
            plane: s.sourcePlane,
            lifecycle: s.lifecycle,
            eventType: s.eventType,
            fingerprint: s.structuralFingerprint,
            shapePaths: s.shapePaths ?? [],
            discriminators: s.discriminatorValues ?? {},
            outcomeKind: s.outcome?.kind ?? null,
            count: s.seenCount ?? 1,
          })
        }
      } catch {
        continue
      }
    }
  }
}

// ---- Classify ---------------------------------------------------------------
const index = buildFingerprintIndex(ALL_RENDER_SHAPE_CATALOGS)
const byStatus = new Map<string, Map<string, Observation[]>>()
for (const obs of observations) {
  const classification = classifySighting(
    {
      structuralFingerprint: obs.fingerprint,
      lifecycle: obs.lifecycle as never,
      // Bundle observations carry no outcome; classify them with a neutral
      // generic outcome so lifecycle/structure coverage still applies.
      outcome:
        obs.outcomeKind === null
          ? { kind: 'generic', rendererId: 'shared.generic-tool' }
          : ({ kind: obs.outcomeKind } as never),
    },
    index,
  )
  const status = byStatus.get(classification.kind) ?? new Map<string, Observation[]>()
  const group = status.get(`${obs.provider} ${obs.fingerprint}`) ?? []
  group.push(obs)
  status.set(`${obs.provider} ${obs.fingerprint}`, group)
  byStatus.set(classification.kind, status)
}

const summary = [...byStatus.entries()]
  .map(([status, groups]) => `${status}: ${groups.size} shapes / ${[...groups.values()].reduce((n, g) => n + g.reduce((m, o) => m + o.count, 0), 0)} sightings`)
  .join('\n')
console.log(`observations: ${observations.length}\n${summary}\n`)

// ---- Seed mode --------------------------------------------------------------
if (SEED) {
  const unknown = byStatus.get('unknown-structure') ?? new Map()
  for (const [key, group] of [...unknown.entries()].sort()) {
    const first = group[0]
    const total = group.reduce((n: number, o: Observation) => n + o.count, 0)
    const planes = [...new Set(group.map((o: Observation) => o.plane))].sort()
    const lifecycles = [...new Set(group.map((o: Observation) => o.lifecycle))].sort()
    const eventTypes = [...new Set(group.map((o: Observation) => o.eventType))].sort()
    const disc =
      first.discriminators.name ??
      first.discriminators.toolName ??
      Object.values(first.discriminators)[0] ??
      eventTypes[0]
    const slug = String(disc).toLowerCase().replace(/^mcp__[^_]+(?:_[^_]+)*__/, 'mcp-').replace(/[^a-z0-9]+/g, '-')
    console.log(`// ${key} — ${total} sightings, planes ${planes.join('/')}`)
    console.log(`'${first.provider}.${planes[0].replace('committed-', '')}.${slug}.v1': defineRenderShape({`)
    console.log(`  id: '${first.provider}.${planes[0].replace('committed-', '')}.${slug}.v1',`)
    console.log(`  provider: '${first.provider}',`)
    console.log(`  fingerprints: ['${first.fingerprint}'],`)
    console.log(`  eventTypes: ${JSON.stringify(eventTypes)},`)
    console.log(`  planes: ${JSON.stringify(planes)},`)
    console.log(`  lifecycles: ${JSON.stringify(lifecycles)},`)
    console.log(`  // paths: ${first.shapePaths.slice(0, 12).join(' ')}`)
    console.log(`}),\n`)
  }
}

const unclassified = (byStatus.get('unknown-structure')?.size ?? 0) + (byStatus.get('known-misrouted')?.size ?? 0)
process.exit(unclassified > 0 ? 1 : 0)
