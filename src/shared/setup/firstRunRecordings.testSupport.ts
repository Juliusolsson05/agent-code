import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { deriveReadiness } from '@shared/setup/readiness.js'
import type { SetupCheckResult, SetupToolId } from '@shared/types/setup.js'

/**
 * Loads a first-run recording (testing/fixtures/first-run, #995) as the exact
 * SetupCheckResult main sent over `setup:check`. Tests feed THIS to the gate,
 * the bootstrap and the pickers instead of building a check by hand.
 */
export type FirstRunEnvironment = 'clean-machine' | 'clean-machine-packaged' | 'developer-machine'

const FIXTURES = resolve(__dirname, '../../../testing/fixtures/first-run')

export function loadFirstRunCheck(environment: FirstRunEnvironment): SetupCheckResult {
  const recording = JSON.parse(readFileSync(resolve(FIXTURES, `${environment}.json`), 'utf8')) as { check: SetupCheckResult }
  return recording.check
}

/**
 * The recording with every tool found at a MACHINE-WIDE path removed: the
 * recording machine's own installs outside the simulated HOME (its npm-global
 * Grok in /opt/homebrew). The result is the factory-fresh Mac with no provider
 * at all.
 *
 * WHY an edit, stated in the one place it happens: that Mac cannot be recorded
 * on the recording machine, because the probes rightly look in /opt/homebrew.
 * The edit is only the `found`/`path`/`source` of those rows; readiness is then
 * re-derived by the real policy, never typed. The unedited zero-provider case
 * runs live on the macOS CI runner, which has no provider CLI
 * (prerequisites.firstRun.test.ts).
 */
export function withoutMachineWideInstalls(check: SetupCheckResult): SetupCheckResult {
  const tools = Object.fromEntries(
    Object.entries(check.tools).map(([id, tool]) =>
      tool.provider && tool.source === 'system' && tool.path?.startsWith('/')
        ? [id, { ...tool, found: false, path: null, source: undefined }]
        : [id, tool],
    ),
  ) as Record<SetupToolId, SetupCheckResult['tools'][SetupToolId]>
  return { ...check, tools, ...deriveReadiness(tools) }
}

/** The pre-#995 verdicts, recorded on main 82babd21. */
export function loadFirstRunBaseline(): Record<FirstRunEnvironment, { verdict: { ready: boolean; blocking: string[] } }> {
  const baseline = JSON.parse(readFileSync(resolve(FIXTURES, 'baseline-main-82babd21.json'), 'utf8')) as {
    environments: Record<FirstRunEnvironment, { verdict: { ready: boolean; blocking: string[] } }>
  }
  return baseline.environments
}
