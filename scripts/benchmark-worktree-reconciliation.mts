// Run from the repository root:
// TSX_TSCONFIG_PATH=tsconfig.web.json node --import tsx scripts/benchmark-worktree-reconciliation.mts
// WHY standalone, not a timing assertion in Vitest: CI host load changes the
// timings; the regression suite asserts identities and actual retained-record
// reads deterministically. This reports isolated costs, not typing latency.
import { readFileSync } from 'node:fs'
import { LiveWorktreeReconciler } from '../src/renderer/src/workspace/work-context/LiveWorktreeReconciler.js'

const fixtureRoot = 'testing/fixtures/worktree-live-attribution/'
const fixture = JSON.parse(readFileSync(`${fixtureRoot}codex-0151-worktree-window.json`, 'utf8'))
const catalog = JSON.parse(readFileSync(`${fixtureRoot}git-worktree-identities.json`, 'utf8')).worktrees
const original = fixture.records.find((record: { payload?: { item?: { type?: string } } }) =>
  record.payload?.item?.type === 'CommandExecution')

for (const retained of [0, 100, 500]) {
  const reconciler = new LiveWorktreeReconciler({
    loadWorktrees: async () => ({ ok: true, worktrees: catalog }),
    onCatalogReady: () => undefined,
  })
  await reconciler.refresh(fixture.git.main.path)
  let projection = reconciler.observe('bench', fixture.git.main.path,
    Array.from({ length: retained }, (_, index) => ({ entry: {
      ...original, timestamp: new Date(1700000000000 + index * 1000).toISOString(),
    } })), { workActivity: null, workContext: null })
  const samples: number[] = []
  let identityChanges = 0
  for (let index = 0; index < 200; index += 1) {
    const started = performance.now()
    const next = reconciler.observe('bench', fixture.git.main.path,
      [{ entry: { type: 'irrelevant' } }], projection)
    samples.push(performance.now() - started)
    if (next.workActivity !== projection.workActivity || next.workContext !== projection.workContext) identityChanges += 1
    projection = next
  }
  samples.sort((a, b) => a - b)
  console.log(JSON.stringify({ retained, batches: samples.length, identityChanges,
    medianMs: samples[100], p95Ms: samples[190] }))
  reconciler.dispose()
}
