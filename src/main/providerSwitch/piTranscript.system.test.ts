import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { decodeGrokConversation, decodePiConversation, projectGrokNativeResume, projectPiNativeResume } from 'agent-transcript-parser'
import type { ConversationEntry } from 'agent-transcript-parser'
import { resolvePiSessionDir, resolvePiSessionFile } from 'pi-terminal-headless'
import { loadLiveFixture, referenceActiveBranch, toJsonl, type RecordedRow } from 'pi-terminal-headless/testing/index'
import { resolveGrokTranscriptPath } from 'grok-code-headless'

// Only true edges are stubbed: CLI version/path probes that the Claude and
// Codex adapters would run. Pi and Grok are pure file adapters, so the real
// transcript engine, switch, duplicate and rewind orchestration run against
// real files in a sandboxed PI_CODING_AGENT_DIR / GROK_HOME, over recordings
// of the real pi 0.87.1 and grok 1.0.13.
vi.mock('@main/setup/cliVersion.js', () => ({ readInstalledVersion: vi.fn(async () => ({ ok: true, version: 'test' })) }))
vi.mock('@main/setup/toolchain.js', () => ({ getToolPath: vi.fn(() => '/tool') }))

import { loadPiSnapshot, writeProjectedPiSession } from './piTranscript.js'
import { getHostTranscriptAdapter } from './transcriptEngine.js'
import { switchProvider } from './switchProvider.js'
import { duplicateSession } from './duplicateSession.js'
import { listRewindPrompts, rewindSession } from './rewindSession.js'

let root: string
let cwd: string
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'pi-host-files-')))
  cwd = join(root, 'project (fixture)')
  await mkdir(cwd)
  vi.stubEnv('PI_CODING_AGENT_DIR', join(root, 'pi-agent'))
  vi.stubEnv('PI_CODING_AGENT_SESSION_DIR', '')
  vi.stubEnv('GROK_HOME', join(root, 'grok-home'))
})
afterEach(async () => {
  vi.unstubAllEnvs()
  await rm(root, { recursive: true, force: true })
})

/** Place a recorded session where pi keeps this project's sessions. */
async function placeRecorded(scenario: string): Promise<{ id: string; rows: RecordedRow[]; file: string }> {
  const recorded = Object.values(loadLiveFixture(scenario).files)[0]!
  const rows = [{ ...recorded[0]!, cwd }, ...recorded.slice(1)]
  const id = String(rows[0]!.id)
  const dir = await resolvePiSessionDir({ env: process.env, cwd })
  await mkdir(dir, { recursive: true })
  const file = join(dir, `2026-09-22T00-00-00-000Z_${id}.jsonl`)
  await writeFile(file, toJsonl(rows))
  return { id, rows, file }
}

const textOf = (row: RecordedRow) => ((row.message as { content: Array<{ type: string; text?: string }> }).content).filter(b => b.type === 'text').map(b => b.text).join('')
const userTexts = (entries: ConversationEntry[]) => entries
  .filter(entry => entry.kind === 'message' && entry.role === 'user')
  .map(entry => (entry as Extract<ConversationEntry, { kind: 'message' }>).content.map(part => part.kind === 'text' ? part.text : '').join(''))

describe('Pi host transcript adapter', () => {
  it('reads the branch pi would resume; rewind prompts are the user’s own prompts only', async () => {
    const tree = await placeRecorded('tree')
    const snapshot = await loadPiSnapshot(cwd, tree.id)
    const branchUsers = referenceActiveBranch(tree.rows).filter(row => row.type === 'message' && (row.message as { role: string }).role === 'user').map(textOf)
    // The user's typed prompts; the branch summary is user-role CONTEXT
    // (as pi sends it), never a rewind boundary.
    const typed = snapshot.conversation.entries.filter(entry => entry.kind === 'message' && entry.role === 'user' && (entry.source.raw.message as { role?: string } | undefined)?.role === 'user')
    expect(userTexts(typed)).toEqual(branchUsers)
    expect(snapshot.prompts.map(prompt => prompt.address)).toEqual(typed.map(entry => ({ provider: 'pi', line: entry.source.line, sessionId: tree.id })))
    expect(snapshot.conversation.entries.some(entry => entry.kind === 'message' && entry.role === 'user' && entry.source.raw.type === 'branch_summary')).toBe(true)

    // A `!cmd` run is user context for the model but never a rewind boundary.
    const bash = await placeRecorded('user-bash')
    const bashSnapshot = await loadPiSnapshot(cwd, bash.id)
    expect(bashSnapshot.conversation.entries.some(entry => entry.kind === 'message' && entry.role === 'user' && (entry.source.raw.message as { role: string }).role === 'bashExecution')).toBe(true)
    expect(bashSnapshot.prompts.map(prompt => (prompt.raw.message as { role: string }).role)).toEqual(['user'])
  })

  it('a session pi has not written yet is an empty conversation, and a switch reports it as source-empty', async () => {
    const snapshot = await loadPiSnapshot(cwd, 'fresh-session')
    expect(snapshot.conversation).toMatchObject({ sourceProvider: 'pi', sourceSessionIds: ['fresh-session'], entries: [] })
    await expect(switchProvider({ sourceKind: 'pi', targetKind: 'grok', sourceProviderSessionId: 'fresh-session', cwd })).resolves.toEqual({ kind: 'source-empty', targetKind: 'grok' })
  })

  it('refuses a half-written tail, and never reads a file whose header names another session as this one', async () => {
    const tool = await placeRecorded('tool')
    const text = await readFile(tool.file, 'utf8')
    await writeFile(tool.file, text + '{"type":"message","id":"x"')
    await expect(loadPiSnapshot(cwd, tool.id)).rejects.toThrow(/unterminated/)
    // The header is pi's identity (SessionManager.findById reads headers), and
    // since the package's lookup mirrors that (Astra review, finding 6) a file
    // NAMED for this id whose header names another session is simply not this
    // session: pi would not resume it, so it is an empty conversation — and,
    // the point of the check, none of the other session's rows leak into it.
    // (It used to be found by name and then refused by loadPiSnapshot's own
    // header check, which still guards a file reached any other way.)
    await writeFile(tool.file, text.replace(tool.id, '00000000-0000-4000-8000-00000000dead'))
    await expect(loadPiSnapshot(cwd, tool.id)).resolves.toMatchObject({ conversation: { sourceSessionIds: [tool.id], entries: [] }, prompts: [] })
  })

  it('publishes a projected session pi can find by id; never clobbers, never a partial name', async () => {
    const source = decodePiConversation(Object.values(loadLiveFixture('tool').files)[0]!)
    const id = '00000000-0000-4000-8000-000000000042'
    const projection = projectPiNativeResume(source, { cwd, targetSessionId: id, now: '2026-09-23T00:00:00.000Z' })
    const results = await Promise.allSettled([writeProjectedPiSession(cwd, projection), writeProjectedPiSession(cwd, projection)])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    const path = await resolvePiSessionFile({ env: process.env, cwd, sessionId: id })
    expect(path).not.toBeNull()
    expect(basename(path!)).toBe(projection.fileName)
    expect((await readFile(path!, 'utf8')).trimEnd().split('\n').map(line => JSON.parse(line))).toEqual(projection.values)
    expect((await stat(path!)).mode & 0o777).toBe(0o600)
    expect((await readdir(dirname(path!))).filter(name => name.endsWith('.pending'))).toEqual([])
    await expect(writeProjectedPiSession(cwd, projection)).rejects.toThrow(/already exists/)
    // A header cwd pi would not recognise as its own is refused before any write.
    const elsewhere = projectPiNativeResume(source, { cwd: root, targetSessionId: '00000000-0000-4000-8000-000000000043', now: '2026-09-23T00:00:00.000Z' })
    await expect(writeProjectedPiSession(cwd, elsewhere)).rejects.toThrow(/cwd/)
  })

  it('a symlinked project path publishes under the real path pi will look in', async () => {
    const link = join(root, 'linked')
    await symlink(cwd, link)
    const adapter = getHostTranscriptAdapter('pi')
    const projection = await adapter.projectNativeResume({ schemaVersion: 1, sourceProvider: 'pi', sourceSessionIds: [], entries: [] }, { cwd: link, targetSessionId: '00000000-0000-4000-8000-000000000044', now: '2026-09-23T00:00:00.000Z' })
    expect(projection.values[0]).toMatchObject({ cwd })
    const path = await adapter.write(link, projection)
    expect(await resolvePiSessionFile({ env: process.env, cwd, sessionId: '00000000-0000-4000-8000-000000000044' })).toBe(path)
  })
})

describe('Pi through switch, duplicate and rewind', () => {
  it('switches a recorded Pi session to Grok and back to Pi with its requests and tool cycles', async () => {
    const tool = await placeRecorded('tool')
    const toGrok = await switchProvider({ sourceKind: 'pi', targetKind: 'grok', sourceProviderSessionId: tool.id, cwd })
    if (toGrok.kind !== 'switched') throw new Error('expected a switch')
    const grokDocument = await getHostTranscriptAdapter('grok').read(cwd, toGrok.targetProviderSessionId)
    expect(userTexts(grokDocument.entries)).toEqual(['please [tool] now', 'and again [tool]'])

    const back = await switchProvider({ sourceKind: 'grok', targetKind: 'pi', sourceProviderSessionId: toGrok.targetProviderSessionId, cwd })
    if (back.kind !== 'switched') throw new Error('expected a switch')
    expect(back.targetFilePath).toBe(await resolvePiSessionFile({ env: process.env, cwd, sessionId: back.targetProviderSessionId }))
    const piDocument = (await loadPiSnapshot(cwd, back.targetProviderSessionId)).conversation
    expect(userTexts(piDocument.entries)).toEqual(['please [tool] now', 'and again [tool]'])
    const calls = piDocument.entries.filter(entry => entry.kind === 'tool-call')
    const results = piDocument.entries.filter(entry => entry.kind === 'tool-result')
    expect(calls.map(call => (call as { input: unknown }).input)).toEqual([{ command: 'echo probe-tool-output' }, { command: 'echo probe-tool-output' }])
    expect(results.map(result => (result as { callId: string }).callId)).toEqual(calls.map(call => (call as { callId: string }).callId))
  })

  it('imports a recorded Grok session into Pi', async () => {
    const grokId = '00000000-0000-4000-8000-000000000051'
    const recorded = await readFile(new URL('../../../packages/grok-code-headless/testing/fixtures/recorded/session-014.jsonl', import.meta.url), 'utf8')
    const grokConversation = decodeGrokConversation(recorded.trimEnd().split('\n').map(line => JSON.parse(line)))
    await getHostTranscriptAdapter('grok').write(cwd, projectGrokNativeResume(grokConversation, { cwd, targetSessionId: grokId, now: '2026-09-23T00:00:00.000Z', model: 'grok-4.6' }))
    expect(resolveGrokTranscriptPath(cwd, grokId)).toBeTruthy()
    const result = await switchProvider({ sourceKind: 'grok', targetKind: 'pi', sourceProviderSessionId: grokId, cwd })
    if (result.kind !== 'switched') throw new Error('expected a switch')
    const imported = (await loadPiSnapshot(cwd, result.targetProviderSessionId)).conversation
    expect(userTexts(imported.entries)).toEqual(userTexts(grokConversation.entries))
  })

  it('duplicates a Pi session, and a fresh Pi pane with no file yet', async () => {
    const compaction = await placeRecorded('compaction')
    const copy = await duplicateSession({ provider: 'pi', sourceProviderSessionId: compaction.id, cwd })
    expect(copy.newProviderSessionId).not.toBe(compaction.id)
    const source = (await loadPiSnapshot(cwd, compaction.id)).conversation
    const cloned = (await loadPiSnapshot(cwd, copy.newProviderSessionId)).conversation
    const semantic = (entries: ConversationEntry[]) => entries.filter(entry => entry.kind !== 'opaque').map(({ source: _s, timestamp: _t, ...rest }) => rest)
    expect(semantic(cloned.entries)).toEqual(semantic(source.entries))

    const fresh = await duplicateSession({ provider: 'pi', sourceProviderSessionId: 'never-written', cwd })
    expect((await loadPiSnapshot(cwd, fresh.newProviderSessionId)).conversation.entries.filter(entry => entry.kind !== 'opaque')).toEqual([])
  })

  it('rewinds a Pi session to an earlier prompt, handing that prompt back as the draft', async () => {
    const tool = await placeRecorded('tool')
    const prompts = await listRewindPrompts({ provider: 'pi', sourceProviderSessionId: tool.id, cwd })
    // Newest first; the first prompt has no resumable prefix and is not offered.
    expect(prompts.map(prompt => prompt.text)).toEqual(['and again [tool]'])
    const rewound = await rewindSession({ provider: 'pi', sourceProviderSessionId: tool.id, cwd, anchor: prompts[0]!.address })
    expect(rewound.promptText).toBe('and again [tool]')
    const kept = (await loadPiSnapshot(cwd, rewound.newProviderSessionId)).conversation
    expect(userTexts(kept.entries)).toEqual(['please [tool] now'])
    // The source file is untouched.
    expect(await readFile(tool.file, 'utf8')).toBe(toJsonl(tool.rows))
  })
})
