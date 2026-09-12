import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'

import { installConversationCorpus } from '../../../testing/support/conversations/installCorpus.js'

// The manifest is the count every membership assertion later argues from. If
// the fixture files and the manifest disagree, every "nothing dropped" test
// downstream is arguing from a wrong denominator.
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const c of cleanups.splice(0)) await c() })

describe('conversation corpus', () => {
  it('installs under a temp HOME with the manifest counts', async () => {
    const corpus = await installConversationCorpus()
    cleanups.push(corpus.cleanup)
    const counts = corpus.manifest.counts as {
      claude: { transcripts: number }
      codex: { indexed: number; inFamily: number; control: number }
      opencode: { inFamily: number; control: number }
    }
    const dirs = await readdir(join(corpus.claudeConfigDir, 'projects'))
    let transcripts = 0
    for (const dir of dirs) transcripts += (await readdir(join(corpus.claudeConfigDir, 'projects', dir))).filter(n => n.endsWith('.jsonl')).length
    expect(transcripts).toBe(counts.claude.transcripts)
    const db = new DatabaseSync(join(corpus.codexHome, 'state_5.sqlite'), { readOnly: true })
    const rows = db.prepare('select count(*) as n from threads').get() as { n: number }
    const rewritten = db.prepare('select count(*) as n from threads where rollout_path like ?').get(`${corpus.codexHome}%`) as { n: number }
    db.close()
    expect(rows.n).toBe(counts.codex.inFamily + counts.codex.control)
    expect(rewritten.n).toBe(rows.n)
    const oc = new DatabaseSync(join(corpus.opencodeDataDir, 'opencode.db'), { readOnly: true })
    expect((oc.prepare('select count(*) as n from session').get() as { n: number }).n).toBe(counts.opencode.inFamily + counts.opencode.control)
    oc.close()
    expect(corpus.repoRoot).toBe('/fixture/repo')
    expect(corpus.worktrees.length).toBeGreaterThan(1)
  })
})
