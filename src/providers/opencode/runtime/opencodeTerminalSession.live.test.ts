import { execFile } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'

import { afterEach, expect, it } from 'vitest'

import { OpencodeTerminalSession } from './opencodeTerminalSession.js'

// #877 acceptance, on the real thing: a prompt sent to an OpenCode Terminal
// pane the moment it starts must commit as a user record, on the installed
// OpenCode, through Agent Code's OWN delivery path.
//
// WHY this lives here and not in the package's live test: the package test
// pastes into the TUI after a fixed 10 s grace (`pasteAndSubmit`), which is
// not what Agent Code does. Production delivery is
// `OpencodeTerminalSession.deliverPromptText`, which waits for the TUI's
// server and submits through `prompt_async` (#882). The reported failure was
// exactly "a pane that has just started silently drops the prompt", so the
// test calls delivery immediately after `start()` resolves, with no grace.
//
// Opt-in (a real binary, network, about a minute):
//   AGENT_CODE_OPENCODE_TERMINAL_LIVE=1 [OPENCODE_BINARY=…] [NODE_PTY_PATH=…] \
//     npm run test:live -- src/providers/opencode/runtime/opencodeTerminalSession.live.test.ts
//
// Safety, as in the package's live test: an isolated HOME/XDG (the user's
// OpenCode data and quota are never touched), a free `opencode/*` model, no
// auto-update, and no dangerous mode.
//
// NODE_PTY_PATH: the app's node-pty is rebuilt for Electron's ABI; under
// plain Node point this at a Node build of node-pty if the default fails.

const execFileAsync = promisify(execFile)
const enabled = process.env.AGENT_CODE_OPENCODE_TERMINAL_LIVE === '1'
const binary = process.env.OPENCODE_BINARY ?? join(process.env.HOME ?? '', '.opencode/bin/opencode')
const model = process.env.OPENCODE_TERMINAL_LIVE_MODEL ?? 'opencode/big-pickle'

let cleanup: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const step of cleanup.reverse()) await step()
  cleanup = []
})

async function waitUntil(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
    await new Promise(resolve => setTimeout(resolve, 100))
  }
}

it('commits a prompt delivered the moment the pane starts (#877)', async context => {
  if (!enabled) context.skip('Set AGENT_CODE_OPENCODE_TERMINAL_LIVE=1 to run against the installed OpenCode')
  if (!existsSync(binary)) context.skip(`No OpenCode binary at ${binary}`)

  const root = mkdtempSync(join(tmpdir(), 'ac-oc-live-'))
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const home = join(root, 'home')
  const project = join(root, 'project')
  await execFileAsync('mkdir', ['-p', home, project])
  writeFileSync(join(project, 'README.md'), '# live delivery test\n')
  await execFileAsync('git', ['init', '-q'], { cwd: project })

  const env: Record<string, string | undefined> = {
    PATH: `${dirname(binary)}:/usr/bin:/bin:/usr/sbin:/sbin`,
    HOME: home,
    XDG_DATA_HOME: join(home, '.local/share'),
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_STATE_HOME: join(home, '.local/state'),
    XDG_CACHE_HOME: join(home, '.cache'),
    LANG: 'en_US.UTF-8',
    OPENCODE_DISABLE_AUTOUPDATE: '1',
    OPENCODE_DANGEROUSLY_SKIP_PERMISSIONS: undefined,
    OPENCODE_CONFIG_CONTENT: JSON.stringify({ model, autoupdate: false, share: 'disabled' }),
  }
  const spawnPty = process.env.NODE_PTY_PATH
    ? (createRequire(import.meta.url)(process.env.NODE_PTY_PATH) as { spawn: never }).spawn
    : undefined

  const session = new OpencodeTerminalSession(
    { cwd: project, binary, env, cols: 120, rows: 40 },
    spawnPty ? { spawnPty } : {},
  )
  cleanup.push(() => session.stop())
  const roles: string[] = []
  session.on('jsonl-entry', (record: { info?: { role?: string } }) => {
    if (record.info?.role) roles.push(record.info.role)
  })
  const exits: unknown[] = []
  session.on('exit', code => { exits.push(code) })

  await session.start()
  // No grace, no wait for first paint: this is the call that used to be
  // acknowledged and then silently dropped by a booting TUI.
  await session.deliverPromptText('Reply with exactly the word pong and nothing else.')

  await waitUntil(() => roles.includes('user'), 120_000, 'the prompt to commit as a user record')
  await waitUntil(() => roles.includes('assistant'), 180_000, 'an assistant reply')
  expect(exits).toEqual([])
}, 360_000)
