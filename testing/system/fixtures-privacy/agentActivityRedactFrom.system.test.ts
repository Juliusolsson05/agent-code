import { execFile, execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'

import { afterEach, describe, expect, it } from 'vitest'

// SYSTEM tier: runs the real extractor script as a process, the way the regeneration is documented
// (steering q74). The script writes to `<cwd>/testing/fixtures/agent-activity/runtime-states.json`,
// so each case runs in a temp cwd holding a sentinel file there; the tracked fixture is never touched.

const run = promisify(execFile)
const REPO = resolve(__dirname, '../../..')
const SCRIPT = join(REPO, 'scripts/extract-agent-activity-runtimes.mts')
const TSX = join(REPO, 'node_modules/.bin/tsx')
const SENTINEL = '{"sentinel":true}\n'
// `git rev-parse 15e43abe^:testing/fixtures/agent-activity/runtime-states.json`
const RECORDED_CORPUS_BLOB = 'd2653405a1aaf3869060d0124cba80fd0fbcf939'

function hasRecordedCorpus(): boolean {
  try {
    execFileSync('git', ['cat-file', '-e', RECORDED_CORPUS_BLOB], { cwd: REPO, stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

// The recorder is read from the corpus itself, so this file never spells the name out.
function recorderOf(corpus: string): string {
  const match = /\/Users\/([^/"]+)\//.exec(corpus)
  if (!match) throw new Error('recorded corpus has no home path')
  return match[1]!
}

// A pre-redaction record in the shape the corpus has: the recorder's home in a path and in
// Claude's dash-encoded projects dir.
const UNREDACTED = {
  provenance: 'old',
  records: [{
    worktreePath: '/Users/recorder/Desktop/Development/agent-code',
    projectDir: '/Users/recorder/.claude/projects/-Users-recorder-Desktop-Development-agent-code',
  }],
}

let cwd: string | undefined
afterEach(async () => {
  if (cwd) await rm(cwd, { recursive: true, force: true })
  cwd = undefined
})

async function stage(): Promise<{ input: string; output: string }> {
  cwd = await mkdtemp(join(tmpdir(), 'agent-activity-redact-from-'))
  const output = join(cwd, 'testing/fixtures/agent-activity/runtime-states.json')
  await mkdir(join(cwd, 'testing/fixtures/agent-activity'), { recursive: true })
  await writeFile(output, SENTINEL)
  const input = join(cwd, 'unredacted.json')
  await writeFile(input, JSON.stringify(UNREDACTED))
  return { input, output }
}

async function extract(args: string[]): Promise<{ code: number; stderr: string }> {
  try {
    // HOME is the temp cwd: if a mistake ever reached the live extraction, it would find no
    // bundles instead of reading (and fixture-ising) this machine's real ones.
    await run(TSX, ['--tsconfig', join(REPO, 'tsconfig.node.json'), SCRIPT, ...args], { cwd, env: { ...process.env, HOME: cwd } })
    return { code: 0, stderr: '' }
  } catch (error) {
    const failed = error as { code?: number; stderr?: string }
    return { code: failed.code ?? -1, stderr: failed.stderr ?? '' }
  }
}

describe.skipIf(process.platform === 'win32')('extract-agent-activity-runtimes --redact-from', () => {
  it('refuses without --home-user and leaves the output untouched', async () => {
    const { input, output } = await stage()
    const result = await extract(['--redact-from', input])
    expect(result.code).not.toBe(0)
    expect(result.stderr).toMatch(/needs --home-user/)
    expect(await readFile(output, 'utf8')).toBe(SENTINEL)
  }, 60_000)

  it('refuses a wrong --home-user rather than write the recorder\'s path', async () => {
    const { input, output } = await stage()
    const result = await extract(['--redact-from', input, '--home-user', 'someoneelse'])
    expect(result.code).not.toBe(0)
    expect(result.stderr).not.toContain('recorder')
    expect(await readFile(output, 'utf8')).toBe(SENTINEL)
  }, 60_000)

  // Steering q76: with --home-user recorder the placeholder is `fixture-`, and the first output guard
  // accepted any home segment that prefix starts with — so a foreign `/Users/fixture/…` was written.
  it('refuses a foreign home that only shares a prefix with the placeholder', async () => {
    const { output } = await stage()
    const input = join(cwd!, 'foreign.json')
    await writeFile(input, JSON.stringify({ provenance: 'old', records: [{ worktreePath: '/Users/fixture/Desktop/Development/agent-code' }] }))
    const result = await extract(['--redact-from', input, '--home-user', 'recorder'])
    expect(result.code).not.toBe(0)
    expect(await readFile(output, 'utf8')).toBe(SENTINEL)
  }, 60_000)

  // Review of #1353, round 3 a: a bare --redact-from fell through to the LIVE extraction and
  // overwrote the output with whatever this machine's bundles held.
  it.each([
    ['a bare --redact-from', ['--redact-from']],
    ['--redact-from with a flag for its operand', ['--redact-from', '--home-user', 'recorder']],
    ['an unknown flag', ['--redact-form', 'x.json']],
  ])('refuses %s without touching the output', async (_label, args) => {
    const { output } = await stage()
    const result = await extract([...args])
    expect(result.code).not.toBe(0)
    expect(await readFile(output, 'utf8')).toBe(SENTINEL)
  }, 60_000)

  // Review of #1353, round 3 a: a foreign user spelled like the placeholder passed the OUTPUT
  // guard; the source check refuses it.
  it('refuses a foreign home spelled like the placeholder', async () => {
    const { output } = await stage()
    const input = join(cwd!, 'lookalike.json')
    await writeFile(input, JSON.stringify({ provenance: 'old', records: [{ worktreePath: '/Users/fixture-/Desktop/Development/agent-code' }] }))
    const result = await extract(['--redact-from', input, '--home-user', 'recorder'])
    expect(result.code).not.toBe(0)
    expect(await readFile(output, 'utf8')).toBe(SENTINEL)
  }, 60_000)

  // Steering q78: `-Users-recorder-secret-…` began with `recorder-`, so a wrong --home-user wrote
  // the foreign user's `-secret` suffix into the fixture.
  it('refuses a hyphenated foreign home that starts with the recorder name', async () => {
    const { output } = await stage()
    const input = join(cwd!, 'hyphenated.json')
    await writeFile(input, JSON.stringify({
      provenance: 'old',
      records: [{
        worktreePath: '/Users/recorder/Desktop/Development/agent-code',
        projectDir: '/Users/recorder/.claude/projects/-Users-recorder-secret-Desktop-Development-agent-code',
      }],
    }))
    const result = await extract(['--redact-from', input, '--home-user', 'recorder'])
    expect(result.code).not.toBe(0)
    expect(await readFile(output, 'utf8')).toBe(SENTINEL)
  }, 60_000)

  // Manager, steering q78: --redact-from reproduces the ONE recorded corpus; any other source is
  // refused even when every home in it is the named recorder (the pattern-based pass cannot
  // promise to recognise every private identifier in an arbitrary corpus).
  it('refuses a source other than the recorded corpus, even with the right --home-user', async () => {
    const { input, output } = await stage()
    const result = await extract(['--redact-from', input, '--home-user', 'recorder'])
    expect(result.code).not.toBe(0)
    expect(result.stderr).toMatch(/only accepts the recorded pre-redaction corpus/)
    expect(await readFile(output, 'utf8')).toBe(SENTINEL)
  }, 60_000)

  // The positive path: the recorded corpus, re-redacted, is byte-identical to the committed file.
  // It needs the pre-redaction blob from git history, which a shallow CI checkout does not have;
  // there it is skipped, and the byte-identity is also stated (with its command) in the PR.
  it.skipIf(!hasRecordedCorpus())('reproduces the committed fixture from the recorded corpus', async () => {
    const { output } = await stage()
    const input = join(cwd!, 'recorded.json')
    await writeFile(input, execFileSync('git', ['cat-file', 'blob', RECORDED_CORPUS_BLOB], { cwd: REPO }))
    const recorder = recorderOf(await readFile(input, 'utf8'))
    expect((await extract(['--redact-from', input, '--home-user', recorder])).code).toBe(0)
    expect(await readFile(output, 'utf8')).toBe(await readFile(join(REPO, 'testing/fixtures/agent-activity/runtime-states.json'), 'utf8'))
  }, 120_000)
})
