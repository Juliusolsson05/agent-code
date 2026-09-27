import { execFile } from 'node:child_process'
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

  it('writes the redacted file with the right --home-user', async () => {
    const { input, output } = await stage()
    expect((await extract(['--redact-from', input, '--home-user', 'recorder'])).code).toBe(0)
    const written = await readFile(output, 'utf8')
    expect(written).not.toContain('recorder')
    expect(written).toContain('/Users/fixture-/Desktop/Development/agent-code')
  }, 60_000)
})
