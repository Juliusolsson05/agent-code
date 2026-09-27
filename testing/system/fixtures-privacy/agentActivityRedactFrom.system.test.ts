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
    await run(TSX, ['--tsconfig', join(REPO, 'tsconfig.node.json'), SCRIPT, ...args], { cwd })
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

  it('writes the redacted file with the right --home-user', async () => {
    const { input, output } = await stage()
    expect((await extract(['--redact-from', input, '--home-user', 'recorder'])).code).toBe(0)
    const written = await readFile(output, 'utf8')
    expect(written).not.toContain('recorder')
    expect(written).toContain('/Users/fixture-/Desktop/Development/agent-code')
  }, 60_000)
})
