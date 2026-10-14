import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { projectWorkspace, SIDEKICK_PLACEMENT_TITLE } from '@main/agentActivity/workspaceProjection.js'
import { ConversationLedger } from '@main/conversations/ledger/ledger.js'
import { parseWorkspaceFile } from '@main/storage/workspaceFile.js'
import { tldrIdentitiesInUse } from '@main/tldr/identitiesInUse.js'

// The four main-side readers that only ever see sessions through the
// committed workspace document (#1493 plan §4). A sidekick is never in a
// window slice, so each of these silently treated it as non-existent:
//   - the conversation ledger marked its conversation CLOSED on every save,
//   - TLDR/Goal could evict its identity at their cap,
//   - Agent Activity and the phone lost its title and name.
// Driven by the documented mutation of a real 2026-10-14 capture
// (testing/fixtures/workspace-v3/README.md): one Claude and one Hermes
// sidekick, with every other real row still in the window slice.

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })

async function fixture() {
  const text = await readFile(join(process.cwd(), 'testing/fixtures/workspace-v3/2026-10-14-live-workspace-with-sidekicks.mutated.json'), 'utf8')
  const parsed = parseWorkspaceFile(text, () => 'minted')
  if (parsed.kind !== 'ok' || !parsed.file.sidekicks) throw new Error('fixture did not parse with sidekicks')
  return { windows: parsed.file.windows, sidekicks: parsed.file.sidekicks }
}

describe('main projections see sidekicks', () => {
  it('keeps a sidekick conversation open in the ledger across saves, and closes it only when removed', async () => {
    const { windows, sidekicks } = await fixture()
    const dir = await mkdtemp(join(tmpdir(), 'sidekick-ledger-'))
    cleanups.push(() => rm(dir, { recursive: true, force: true }))
    const ledger = await ConversationLedger.open(join(dir, 'ledger.jsonl'))
    const claude = sidekicks.records[0]!.meta as { kind: string; providerSessionId: string }

    await ledger.projectWindows(windows, {}, 1, sidekicks)
    await ledger.projectWindows(windows, {}, 2, sidekicks)
    expect(ledger.get('claude', claude.providerSessionId)).toMatchObject({ closedAt: null, cwd: '/fixture/home' })

    // Without the sidekicks argument (what every save did before #1493) the
    // same row is marked closed: this is the failure, stated directly.
    await ledger.projectWindows(windows, {}, 3)
    expect(ledger.get('claude', claude.providerSessionId)?.closedAt).toBe(3)

    // Remove Sidekick drops the record; the conversation is then closed for real.
    await ledger.projectWindows(windows, {}, 4, sidekicks)
    expect(ledger.get('claude', claude.providerSessionId)?.closedAt).toBeNull()
    await ledger.projectWindows(windows, {}, 5, { version: 1, records: [] })
    expect(ledger.get('claude', claude.providerSessionId)?.closedAt).toBe(5)
  })

  it('protects sidekick TLDR/Goal identities and session ids from eviction', async () => {
    const { windows, sidekicks } = await fixture()
    const inUse = tldrIdentitiesInUse(windows, sidekicks)!
    for (const record of sidekicks.records) {
      expect(inUse.has(record.sessionId)).toBe(true)
      const identity = (record.meta as { tldrIdentity?: string }).tldrIdentity
      if (identity) expect(inUse.has(identity)).toBe(true)
    }
    const without = tldrIdentitiesInUse(windows)!
    expect(sidekicks.records.some(record => !without.has(record.sessionId))).toBe(true)
  })

  it('places sidekicks under the Sidekick title for Agent Activity and the phone', async () => {
    const { windows, sidekicks } = await fixture()
    const projection = projectWorkspace(windows, sidekicks)
    const hermes = projection.sessions.get(sidekicks.records[1]!.sessionId)
    expect(hermes).toMatchObject({ kind: 'hermes', tabId: null, tabTitle: SIDEKICK_PLACEMENT_TITLE, pinned: false, orchestration: false })
    // Every real lane row is still placed exactly as before.
    expect(projection.sessions.size).toBe(projectWorkspace(windows).sessions.size + sidekicks.records.length)
  })
})
