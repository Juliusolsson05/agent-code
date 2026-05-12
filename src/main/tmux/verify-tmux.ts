// Standalone integration check for TmuxRegistry. Run with `tsx`.
// Exits non-zero on any failure. No test framework — this matches
// the verify scripts in the headless packages.

import { TmuxRegistry } from '@main/tmux/TmuxRegistry.js'
import { reconcile } from '@main/tmux/tmuxRecovery.js'

const PREFIX = process.env.TMUX_TEST_PREFIX ?? 'agentcode-verify-'
let failed = 0

function check(label: string, ok: boolean, detail?: string): void {
  if (ok) {
    console.log(`✓ ${label}`)
  } else {
    console.error(`✗ ${label}${detail ? ` — ${detail}` : ''}`)
    failed++
  }
}

async function main(): Promise<void> {
  const registry = new TmuxRegistry({ namePrefix: PREFIX })

  const available = await registry.detectAvailability()
  check('tmux is available', available, 'install with `brew install tmux`')
  if (!available) process.exit(1)

  const name = registry.generateName()
  check('generated name has prefix', name.startsWith(PREFIX))

  await registry.createSession({
    name,
    command: process.env.SHELL ?? '/bin/zsh',
    cwd: process.cwd(),
  })
  check('createSession completes', true)

  const existsAfterCreate = await registry.sessionExists(name)
  check('sessionExists is true after create', existsAfterCreate)

  await registry.killSession(name)
  check('killSession completes', true)

  const existsAfterKill = await registry.sessionExists(name)
  check('sessionExists is false after kill', !existsAfterKill)

  const names = [registry.generateName(), registry.generateName(), registry.generateName()]
  for (const n of names) {
    await registry.createSession({
      name: n,
      command: process.env.SHELL ?? '/bin/zsh',
      cwd: process.cwd(),
    })
  }
  const listed = await registry.listManagedSessions()
  const listedNames = new Set(listed.map(s => s.name))
  check(
    'listManagedSessions returns all three created sessions',
    names.every(n => listedNames.has(n)),
    `expected ${JSON.stringify(names)}, got ${JSON.stringify([...listedNames])}`,
  )
  for (const n of names) await registry.killSession(n)

  // Recovery check: create two sessions, simulate one as "persisted"
  // and the other as an orphan. Reconcile and verify all three buckets.
  const sessionA = registry.generateName()
  const sessionB = registry.generateName()
  await registry.createSession({ name: sessionA, command: process.env.SHELL ?? '/bin/zsh' })
  await registry.createSession({ name: sessionB, command: process.env.SHELL ?? '/bin/zsh' })

  const report = await reconcile(registry, [
    { sessionId: 'fake-id-a', tmuxName: sessionA },
    { sessionId: 'fake-id-dead', tmuxName: `${PREFIX}does-not-exist` },
  ])

  check(
    'reconcile recovers the alive+known session',
    report.recoverable.length === 1 && report.recoverable[0].tmuxName === sessionA,
  )
  check(
    'reconcile flags the dead+known session as lost',
    report.lost.length === 1 && report.lost[0] === 'fake-id-dead',
  )
  check(
    'reconcile killed the orphan',
    !(await registry.sessionExists(sessionB)),
  )

  await registry.killSession(sessionA)

  if (failed > 0) process.exit(1)
}

void main()
