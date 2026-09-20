import { existsSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import {
  CORPUS_ROOTS,
  loadImageFixtures,
  unreachableCitations,
} from '@providers/shared/renderer/protocols/media/imageFixtureProvenance'

// The second opinion on image-fixture provenance, for whoever still holds the
// corpus the fixtures were extracted from (#901).
//
// WHY it is opt-in and not "run it if the directory exists": that is exactly
// the shape that broke the deterministic gate. A developer who rotates old
// transcripts — which is ordinary housekeeping, and what the providers
// themselves do — has nothing wrong with their checkout, and `npm test` must
// say so. `docs/testing/standard.md` calls reading a home directory live
// behaviour requiring an explicit variable, and this is that variable.
//
// A failure here means a cited session is gone from THIS machine. That is
// information, not a defect: the fixture's real provenance gate is that
// scripts/extract-image-fixtures.mts could only have produced it by reading
// that exact file at that exact line.
const enabled = process.env.AGENT_CODE_LIVE_IMAGE_CORPUS === '1'

describe.skipIf(!enabled)('image fixtures against the local corpus', () => {
  it('every cited session is still on this machine', () => {
    expect(existsSync(CORPUS_ROOTS.claude) || existsSync(CORPUS_ROOTS.codex)).toBe(true)
    expect(unreachableCitations(loadImageFixtures(), existsSync)).toEqual([])
  })
})
