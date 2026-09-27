import { execFile, execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'

import { afterEach, describe, expect, it } from 'vitest'

import { homePlaceholder } from '../../../scripts/agent-activity-redaction-policy'

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

async function extract(args: string[], env: Record<string, string> = {}): Promise<{ code: number; stderr: string }> {
  try {
    // HOME is the temp cwd: a live extraction reads only the bundles this test planted there,
    // never this machine's real ones.
    await run(TSX, ['--tsconfig', join(REPO, 'tsconfig.node.json'), SCRIPT, ...args], { cwd, env: { ...process.env, HOME: cwd, ...env } })
    return { code: 0, stderr: '' }
  } catch (error) {
    const failed = error as { code?: number; stderr?: string }
    return { code: failed.code ?? -1, stderr: failed.stderr ?? '' }
  }
}

// A debug bundle in the layout the live extraction reads: <HOME>/.config/agent-code/debug-bundles/
// <dir>/{manifest,state-snapshot}.json. `home` is the user segment the paths claim to live under.
async function liveBundle(snapshot: Record<string, unknown>, projectDir: string): Promise<void> {
  const dir = join(cwd!, '.config/agent-code/debug-bundles/2026-09-27T00-00-00-000-abcdef12')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'manifest.json'), JSON.stringify({ sessionId: 'abcdef12', kind: 'claude', capturedAt: 1, projectDir }))
  await writeFile(join(dir, 'state-snapshot.json'), JSON.stringify(snapshot))
}

// Review of #1353 (steering q79/q80): a no-argument LIVE run wrote a private project outside
// Development/ into the tracked fixture, and then an `--out` staging path could be a symlink back to
// it. Live mode now takes no arguments and writes only into a fresh temp directory it creates.
// The child's TMPDIR is a short temp directory of the test's own, so its staging directory is found
// (and cleaned) here, never mixed into the machine's shared temp dir. Short on purpose: tsx puts
// an IPC socket under TMPDIR, and socket paths are length-limited.
let stagingParent: string | undefined
afterEach(async () => {
  if (stagingParent) await rm(stagingParent, { recursive: true, force: true })
  stagingParent = undefined
})
async function stagedFiles(): Promise<string[]> {
  const dirs = (await readdir(stagingParent!)).filter(name => name.startsWith('agent-activity-staging-'))
  return dirs.map(dir => join(stagingParent!, dir, 'runtime-states.json'))
}
async function live(args: string[] = []) {
  stagingParent = await mkdtemp(join(tmpdir(), 'aas-'))
  return extract(args, { TMPDIR: stagingParent })
}

describe.skipIf(process.platform === 'win32')('extract-agent-activity-runtimes (live)', () => {
  // The A reproduction (a private project outside Development/) plus the q80 one: a symlink planted
  // at the OLD staging path, pointing at the tracked fixture. Neither can reach the tracked file.
  it('stages into a fresh temp directory and never touches the tracked fixture, even through a planted symlink', async () => {
    const { output } = await stage()
    const me = cwd!.split('/').pop()!
    await liveBundle({ provider: 'claude', worktreePath: `/Users/${me}/Projects/secretproject/private-task` }, `/Users/${me}/Projects/secretproject/private-task`)
    await mkdir(join(cwd!, 'temp/fixture-staging'), { recursive: true })
    await symlink(output, join(cwd!, 'temp/fixture-staging/runtime-states.json'))
    const result = await live()
    expect(result.code).toBe(0)
    expect(await readFile(output, 'utf8')).toBe(SENTINEL)
    const staged = await stagedFiles()
    expect(staged).toHaveLength(1)
    expect(await readFile(staged[0]!, 'utf8')).not.toContain(me)
  }, 60_000)

  // Steering q81: os.tmpdir() follows TMPDIR, so a TMPDIR pointing into a repository (here through
  // a symlink, which also keeps tsx's socket path short) staged the unaudited file inside the working
  // tree. The run must refuse before reading a bundle, leaving no private bytes in the repo.
  it('refuses a TMPDIR inside a git worktree, even through a symlink, and leaves nothing there', async () => {
    const { output } = await stage()
    execFileSync('git', ['init', '-q'], { cwd: cwd! })
    const me = cwd!.split('/').pop()!
    await liveBundle({ provider: 'claude', worktreePath: `/Users/${me}/Projects/secretproject/private-task` }, `/Users/${me}/Projects/secretproject/private-task`)
    stagingParent = await mkdtemp(join(tmpdir(), 'aas-'))
    const intoRepo = join(stagingParent, 'r')
    await symlink(cwd!, intoRepo)
    const result = await extract([], { TMPDIR: intoRepo })
    expect(result.code).not.toBe(0)
    expect(result.stderr).toMatch(/inside a git working tree/)
    expect(await readFile(output, 'utf8')).toBe(SENTINEL)
    expect((await readdir(cwd!)).filter(name => name.startsWith('agent-activity-staging-'))).toEqual([])
    // No file in the repository holds the private bytes, except the planted bundle itself.
    const files = (await readdir(cwd!, { recursive: true, withFileTypes: true }))
      .filter(entry => entry.isFile())
      .map(entry => join(entry.parentPath, entry.name))
      .filter(path => !path.includes('/.config/') && !path.includes('/.git/'))
    for (const path of files) expect(await readFile(path, 'utf8'), path).not.toContain('secretproject')
  }, 60_000)

  // Final check of #1353 (a and c): git's own discovery can be switched off from the environment,
  // and "git gave no answer" was read as "outside a worktree". GIT_CEILING_DIRECTORIES above a
  // subdirectory and a bogus GIT_DIR both did it.
  it.each([
    ['GIT_CEILING_DIRECTORIES', (repo: string) => ({ GIT_CEILING_DIRECTORIES: repo })],
    ['a bogus GIT_DIR', (repo: string) => ({ GIT_DIR: join(repo, 'no-such-git-dir') })],
  ])('refuses a TMPDIR inside a worktree whatever %s says', async (_label, gitEnv) => {
    const { output } = await stage()
    execFileSync('git', ['init', '-q'], { cwd: cwd! })
    await mkdir(join(cwd!, 'sub'))
    const me = cwd!.split('/').pop()!
    await liveBundle({ provider: 'claude', worktreePath: `/Users/${me}/Projects/secretproject/private-task` }, `/Users/${me}/Projects/secretproject/private-task`)
    stagingParent = await mkdtemp(join(tmpdir(), 'aas-'))
    const intoRepo = join(stagingParent, 'r')
    await symlink(join(cwd!, 'sub'), intoRepo)
    const result = await extract([], { TMPDIR: intoRepo, ...gitEnv(cwd!) })
    expect(result.code).not.toBe(0)
    expect(await readFile(output, 'utf8')).toBe(SENTINEL)
    expect((await readdir(join(cwd!, 'sub'))).filter(name => name.startsWith('agent-activity-staging-'))).toEqual([])
  }, 60_000)

  it('refuses --out (or any argument) instead of writing anywhere', async () => {
    const { output } = await stage()
    const result = await live(['--out', 'testing/fixtures/agent-activity/runtime-states.json'])
    expect(result.code).not.toBe(0)
    expect(result.stderr).toMatch(/takes no arguments/)
    expect(await readFile(output, 'utf8')).toBe(SENTINEL)
    expect(await stagedFiles()).toEqual([])
  }, 60_000)

  it('refuses a bundle whose homes are not this machine user\'s', async () => {
    await stage()
    await liveBundle({ provider: 'claude', worktreePath: '/Users/someoneelse/Desktop/Development/agent-code' }, '/Users/someoneelse/x')
    expect((await live()).code).not.toBe(0)
    expect(await stagedFiles()).toEqual([])
  }, 60_000)

  // Only the SOURCE check can catch this one: a foreign user named exactly like this machine user's
  // placeholder passes through the pass unchanged and looks like the placeholder afterwards.
  it('refuses a bundle whose foreign home is spelled like the placeholder', async () => {
    await stage()
    const me = cwd!.split('/').pop()!
    await liveBundle({ provider: 'claude', worktreePath: `/Users/${homePlaceholder(me)}/Desktop/Development/secret` }, `/Users/${me}/Desktop/x`)
    expect((await live()).code).not.toBe(0)
    expect(await stagedFiles()).toEqual([])
  }, 60_000)

  it('refuses a bundle with a home spelling the pass does not rewrite', async () => {
    await stage()
    await liveBundle({ provider: 'claude', note: '%2FUsers%2Fsomeoneelse%2Fsecret' }, '')
    expect((await live()).code).not.toBe(0)
    expect(await stagedFiles()).toEqual([])
  }, 60_000)
})

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
