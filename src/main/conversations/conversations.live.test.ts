import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

import { createConversationService } from './service.js'

// The only place the timing budget (docs/decomposition/conversations.md, D6)
// is measured, against the real stores of whoever runs it. Never part of
// `npm test`; opt in with `npm run test:live:conversations`.
const enabled = process.env.AGENT_CODE_LIVE_CONVERSATIONS === '1'
const REPO = process.cwd()
const run = promisify(execFile)

// The production lister lives in @main/ipc/git.js, whose first line imports
// electron; the live suite runs under plain Node, so it asks git directly.
async function listWorktrees(cwd: string): Promise<Array<{ path: string }>> {
  const { stdout } = await run('git', ['worktree', 'list', '--porcelain'], { cwd })
  return stdout.split('\n').filter(l => l.startsWith('worktree ')).map(l => ({ path: l.slice('worktree '.length) }))
}
const service = () => createConversationService({ ledger: null, listWorktrees })

describe.skipIf(!enabled)('conversations against the live stores', () => {
  it('lists this repository across worktrees within budget and hides its review children', async () => {
    const svc = service()
    const cold0 = performance.now()
    const cold = await svc.list({ cwd: REPO, scope: 'repository', limit: 100 })
    const coldMs = performance.now() - cold0
    const warm0 = performance.now()
    const warm = await svc.list({ cwd: REPO, scope: 'repository', limit: 100 })
    const warmMs = performance.now() - warm0
    // eslint-disable-next-line no-console
    console.log(`live: cold ${coldMs.toFixed(0)} ms, warm ${warmMs.toFixed(0)} ms, total ${cold.total}, hidden ${cold.hiddenChildren}, shown ${cold.rows.length}`)
    expect(coldMs).toBeLessThan(500)
    expect(warmMs).toBeLessThan(100)
    expect(cold.hiddenChildren).toBeGreaterThan(0)
    expect(cold.rows.every(r => r.kind === 'user' || r.kind === 'projected')).toBe(true)
    expect(new Set(cold.rows.map(r => r.provider)).size).toBeGreaterThanOrEqual(2)
    expect(warm.rows.map(r => r.nativeId)).toEqual(cold.rows.map(r => r.nativeId))
    // Readable labels: no row on the live machine may be labelled by the
    // injected AGENTS.md text or a bare wrapper.
    for (const row of cold.rows) {
      expect(row.label.startsWith('# AGENTS.md')).toBe(false)
      expect(row.label.startsWith('<')).toBe(false)
      if (row.provider !== 'claude') expect(row.activitySource).not.toBe('mtime')
    }
  })

  it('never lists fewer conversations than the unredacted corpus recorded', async () => {
    let manifest: { counts: { claude: { inFamily: number }; codex: { inFamily: number } } } | null = null
    try {
      manifest = JSON.parse(await readFile(join(REPO, 'testing', 'fixtures', 'conversations', 'local', 'manifest.json'), 'utf8'))
    } catch {
      manifest = null
    }
    if (!manifest) return
    const all = await service().list({ cwd: REPO, scope: 'repository', includeChildren: true, limit: 5000 })
    // Stores keep growing after the corpus was recorded; the live list must
    // never hold FEWER than the recording did.
    expect(all.total).toBeGreaterThanOrEqual(manifest.counts.claude.inFamily + manifest.counts.codex.inFamily)
  })

  it('searches under budget, and the second search of the same scope is served from the prompt cache', async () => {
    const svc = service()
    await svc.list({ cwd: REPO, scope: 'repository', limit: 10 })
    const t0 = performance.now()
    const hits = await svc.list({ cwd: REPO, scope: 'repository', query: 'read', limit: 30 })
    const firstMs = performance.now() - t0
    const t1 = performance.now()
    const again = await svc.list({ cwd: REPO, scope: 'repository', query: 'read the', limit: 30 })
    const secondMs = performance.now() - t1
    // eslint-disable-next-line no-console
    console.log(`live search: first ${firstMs.toFixed(0)} ms (${hits.rows.length} hits), second ${secondMs.toFixed(0)} ms (${again.rows.length} hits)`)
    // The first search folds prompts for the newest two hundred non-Claude
    // rows; the second reuses them.
    expect(firstMs).toBeLessThan(750)
    expect(secondMs).toBeLessThan(100)
    expect(hits.rows.every(r => r.match !== null)).toBe(true)
  })
})
