import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'
import { loadLiveFixture, referenceActiveBranch, toJsonl, type RecordedRow } from 'pi-terminal-headless/testing/index'
import { encodeCwdForSessionDir } from 'pi-terminal-headless'

import { resolveFamily } from '../family.js'
import { PiConversationSource } from './pi.js'

// The Pi conversation source over Stage 0 recordings of the real pi 0.87.1,
// laid out the way pi lays them out: one directory per cwd under
// <agentDir>/sessions, files named <ts>_<id>.jsonl. Each recorded file is
// rewritten with its header cwd pointed at a project in this sandbox, so
// scoping has something real to scope. Expectations come from the recorded
// rows, never from the source.

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

type Placed = { file: string; rows: RecordedRow[]; id: string; cwd: string }

function sandbox() {
  const home = mkdtempSync(join(tmpdir(), 'pi-catalog-'))
  dirs.push(home)
  const place = (rows: RecordedRow[], cwd: string, nameOverride?: string): Placed => {
    const header = { ...rows[0]!, cwd }
    const fixed = [header, ...rows.slice(1)]
    const dir = join(home, '.pi', 'agent', 'sessions', encodeCwdForSessionDir(cwd))
    mkdirSync(dir, { recursive: true })
    const file = join(dir, nameOverride ?? `2026-09-22T00-00-00-000Z_${header.id as string}.jsonl`)
    writeFileSync(file, toJsonl(fixed))
    return { file, rows: fixed, id: header.id as string, cwd }
  }
  return { home, place }
}

const userTexts = (rows: RecordedRow[]) =>
  rows.filter(row => row.type === 'message' && (row.message as { role: string }).role === 'user')
    .map(row => ((row.message as { content: Array<{ type: string; text?: string }> }).content).filter(b => b.type === 'text').map(b => b.text).join('\n'))

describe('Pi conversation source', () => {
  it('lists the sessions of the repository family, with header cwd, first prompts and the fork parent', async () => {
    const { home, place } = sandbox()
    const repo = join(home, 'repo')
    const other = join(home, 'elsewhere')
    const plain = place(Object.values(loadLiveFixture('plain').files)[0]!, repo)
    const [forkParentRows, forkChildRows] = Object.entries(loadLiveFixture('fork').files).sort(([a], [b]) => a.localeCompare(b)).map(([, rows]) => rows)
    const parent = place(forkParentRows!, join(repo, 'subdir'))
    // The child's header names its parent FILE; point it at the placed parent.
    const child = place([{ ...forkChildRows![0]!, parentSession: parent.file }, ...forkChildRows!.slice(1)], repo)
    const outside = place(Object.values(loadLiveFixture('tool').files)[0]!, other)
    const source = new PiConversationSource({ env: {}, homeDirectory: home })

    const family = await resolveFamily(repo, 'repository', { listWorktrees: async () => [] })
    const rows = await source.discover({ scope: 'repository', family })
    expect(rows.map(row => row.nativeId).sort()).toEqual([plain.id, parent.id, child.id].sort())
    const byId = new Map(rows.map(row => [row.nativeId, row]))
    expect(byId.get(plain.id)).toMatchObject({ provider: 'pi', cwd: repo, userTexts: userTexts(plain.rows).slice(0, 3), origin: 'scan', available: true, file: plain.file })
    expect(byId.get(child.id)!.parentNativeId).toBe(parent.id)
    expect(byId.get(plain.id)!.parentNativeId).toBeNull()

    const everywhere = await source.discover({ scope: 'everywhere', family: await resolveFamily(repo, 'everywhere', { listWorktrees: async () => [] }) })
    expect(everywhere.map(row => row.nativeId)).toContain(outside.id)
  })

  it('prompts come from the active branch, newest first (an abandoned /tree turn is not a prompt of this conversation)', async () => {
    const { home, place } = sandbox()
    const repo = join(home, 'repo')
    const tree = place(Object.values(loadLiveFixture('tree').files)[0]!, repo)
    const source = new PiConversationSource({ env: {}, homeDirectory: home })
    const prompts = await source.prompts(tree.id, repo)
    expect(prompts.map(prompt => prompt.text)).toEqual(userTexts(referenceActiveBranch(tree.rows)).reverse())
    expect(await source.prompts('no-such-session', repo)).toEqual([])
  })

  it('a /name the user gave the session is its custom title', async () => {
    const { home, place } = sandbox()
    const repo = join(home, 'repo')
    const rows = Object.values(loadLiveFixture('plain').files)[0]!
    const named = place([...rows, { type: 'session_info', id: 'ffff0000', parentId: rows.at(-1)!.id, timestamp: '2026-09-22T00:00:01.000Z', name: 'Probe title' }], repo)
    const source = new PiConversationSource({ env: {}, homeDirectory: home })
    const [row] = await source.discover({ scope: 'everywhere', family: await resolveFamily(repo, 'everywhere', { listWorktrees: async () => [] }) })
    expect(row).toMatchObject({ nativeId: named.id, customTitle: 'Probe title' })
    expect(basename(row!.file!)).toBe(basename(named.file))
  })

  it('files that are not Pi sessions are skipped, not reported as conversations', async () => {
    const { home } = sandbox()
    const dir = join(home, '.pi', 'agent', 'sessions', '--x--')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, '2026-09-22T00-00-00-000Z_bogus.jsonl'), '{"hello":"world"}\n')
    const source = new PiConversationSource({ env: {}, homeDirectory: home })
    expect(await source.discover({ scope: 'everywhere', family: await resolveFamily(home, 'everywhere', { listWorktrees: async () => [] }) })).toEqual([])
  })
})
