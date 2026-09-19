import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { SetupCheckResult, SetupToolId } from '@shared/types/setup'

// Stage 1 of docs/decomposition/onboarding-first-run.md (#995): the fresh-run
// recorder.
//
// WHY this runs the REAL checkPrerequisites instead of feeding a typed-in
// SetupCheckResult to the policy: every layer that decides "is Claude
// installed?" (login-shell `command -v`, the PATH + well-known-dir scan, the
// persisted-path fallback, bundled-archive detection) reads the machine. A
// fixture someone typed would encode what they THINK a clean Mac looks like.
// Here the machine is simulated at its edges only, and every probe runs:
//
//   - HOME is a fresh temp dir. On macOS every provider CLI installs under
//     HOME (~/.local/bin for Claude's native installer, Codex's and Grok's;
//     ~/.opencode/bin for OpenCode), so a fresh HOME is a machine that never
//     ran an installer. STATE_DIR (~/.config/agent-code) follows HOME, which is
//     also "first launch ever".
//   - PATH is launchd's minimal PATH, which is what a Finder/Dock launch gets.
//   - SHELL is /bin/sh, so the login-shell probe sources only the system
//     profile (path_helper), never this developer's rc files.
//   - Electron's app path is a temp dir. `clean-machine` has nothing there
//     (a dev build that never staged runtimes, or any pre-#994 build).
//     `clean-machine-packaged` stages exactly the tree the packaged app ships
//     for OpenCode: the manifest and the binary at the path the real resolver
//     computes (#994, runtimeTools.ts opencodeBinaryPath).
//
// System-level tools (/usr/bin/git, Homebrew in /opt/homebrew) stay visible
// because they are outside HOME. That is recorded, not hidden: the policy
// treats them as optional, and the live check below compares provider rows
// only, which are the rows that are deterministic on every macOS machine
// including the CI runner.
//
// RECORD_FIRST_RUN=1 rewrites testing/fixtures/first-run/*.json from this
// machine. Without it, the test re-runs the clean simulations live and fails if
// the committed recordings no longer match what the real code reports, so a
// fixture cannot silently drift away from reality.

const appRoot = { path: '' }
vi.mock('electron', () => ({
  app: {
    getAppPath: () => appRoot.path,
    getPath: (name: string) => join(appRoot.path, name),
    isPackaged: false,
  },
}))

const REPO = resolve(__dirname, '../../..')
const FIXTURES = join(REPO, 'testing/fixtures/first-run')
const RECORD = process.env.RECORD_FIRST_RUN === '1'
const PROVIDER_ROWS: SetupToolId[] = ['claude', 'codex', 'opencode', 'grok']

type Environment = 'clean-machine' | 'clean-machine-packaged' | 'developer-machine'

/** One recorded tool row, with machine paths reduced to `~` so the fixture
 *  holds no username. `path` stays: it is the evidence of WHERE a tool was
 *  found (bundled vs ~/.local/bin vs /opt/homebrew), which the policy and a
 *  future reader both need. */
export type RecordedTool = Pick<SetupCheckResult['tools'][SetupToolId], 'id' | 'found' | 'path' | 'source'>
export type FirstRunRecording = {
  environment: Environment
  /** Why this environment exists and what it simulates. */
  description: string
  platform: string
  arch: string
  tools: Record<SetupToolId, RecordedTool>
  /** The verdict fields exactly as the code at recording time returned them.
   *  Kept so the baseline (the pre-#995 wall) stays legible after the policy
   *  changes; nothing asserts against them. */
  verdictAtRecording: Record<string, unknown>
}

const saved = { HOME: process.env.HOME, PATH: process.env.PATH, SHELL: process.env.SHELL }
const temps: string[] = []
afterEach(async () => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  for (const dir of temps.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function temp(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  temps.push(dir)
  return dir
}

/** Stages the packaged OpenCode runtime exactly where runtimeTools.ts looks. */
async function stageBundledOpencode(root: string): Promise<void> {
  const manifestPath = join(REPO, 'third_party/opencode/manifest.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { executableInsideArchive: string }
  const arch = process.arch === 'x64' ? 'x86_64' : process.arch
  const runtime = join(root, 'out/main/runtime/opencode')
  await mkdir(join(runtime, `darwin-${arch}`), { recursive: true })
  await copyFile(manifestPath, join(runtime, 'manifest.json'))
  const binary = join(runtime, `darwin-${arch}`, manifest.executableInsideArchive)
  // A stub, not the real 100 MB binary: the setup check asks only whether the
  // file exists (isBundledArchiveAvailable). The toolchain's separate
  // `--version` probe may reject the stub, which affects only its spawn
  // override cache, never the check result recorded here.
  await writeFile(binary, '#!/bin/sh\nexit 0\n')
  await chmod(binary, 0o755)
}

async function runCheck(environment: Environment): Promise<SetupCheckResult> {
  appRoot.path = await temp('first-run-app-')
  if (environment !== 'developer-machine') {
    process.env.HOME = await temp('first-run-home-')
    process.env.PATH = '/usr/bin:/bin:/usr/sbin:/sbin'
    process.env.SHELL = '/bin/sh'
  }
  if (environment === 'clean-machine-packaged') await stageBundledOpencode(appRoot.path)
  // Fresh modules per environment: STATE_DIR and the well-known bin dirs are
  // computed from HOME at module load.
  vi.resetModules()
  const { checkPrerequisites } = await import('@main/setup/prerequisites.js')
  return await checkPrerequisites()
}

function sanitize(path: string | null, home: string): string | null {
  if (!path) return path
  return path.startsWith(home) ? `~${path.slice(home.length)}` : path
}

function record(environment: Environment, description: string, result: SetupCheckResult, home: string): FirstRunRecording {
  const { tools, checkedAt: _checkedAt, ...verdict } = result
  return {
    environment,
    description,
    platform: process.platform,
    arch: process.arch,
    tools: Object.fromEntries(
      Object.entries(tools).map(([id, tool]) => [
        id,
        { id: tool.id, found: tool.found, path: sanitize(tool.path, home), source: tool.source },
      ]),
    ) as Record<SetupToolId, RecordedTool>,
    verdictAtRecording: verdict,
  }
}

async function load(environment: Environment): Promise<FirstRunRecording> {
  return JSON.parse(await readFile(join(FIXTURES, `${environment}.json`), 'utf8')) as FirstRunRecording
}

const DESCRIPTIONS: Record<Environment, string> = {
  'clean-machine':
    'Fresh HOME, launchd PATH, /bin/sh, no staged runtimes: a Mac that never ran a provider installer, on a build without bundled OpenCode.',
  'clean-machine-packaged':
    'The same clean Mac running the packaged app, which ships OpenCode under out/main/runtime/opencode (#994).',
  'developer-machine':
    "The recording developer's real HOME, PATH and SHELL, with every provider CLI installed. Machine-specific; replayed only as policy input.",
}

describe.skipIf(process.platform !== 'darwin')('first-run prerequisites on a simulated clean Mac (#995)', () => {
  it.skipIf(!RECORD)('records every environment', async () => {
    await mkdir(FIXTURES, { recursive: true })
    for (const environment of Object.keys(DESCRIPTIONS) as Environment[]) {
      const result = await runCheck(environment)
      const home = process.env.HOME ?? homedir()
      const recording = record(environment, DESCRIPTIONS[environment], result, home)
      await writeFile(join(FIXTURES, `${environment}.json`), `${JSON.stringify(recording, null, 2)}\n`)
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  }, 120_000)

  it.each(['clean-machine', 'clean-machine-packaged'] as const)(
    '%s: the committed recording still matches the real probes for every provider row',
    async environment => {
      const recording = await load(environment)
      const live = await runCheck(environment)
      // A row the recording found at an absolute, machine-wide path (outside
      // the simulated HOME) is a fact about the recording machine, not about
      // a clean Mac: here, Grok is an npm-global install under Homebrew's
      // node (/opt/homebrew/bin/grok). The CI runner has no such install, so
      // comparing that row would fail for a reason unrelated to the code.
      // Rows found under HOME or bundled, and rows not found, are
      // deterministic on any machine and are always compared.
      const machineWide = (id: SetupToolId) => recording.tools[id].path?.startsWith('/') === true
      for (const id of PROVIDER_ROWS.filter(id => !machineWide(id))) {
        expect({ id, found: live.tools[id].found, source: live.tools[id].source })
          .toEqual({ id, found: recording.tools[id].found, source: recording.tools[id].source })
      }
    },
    60_000,
  )
})
