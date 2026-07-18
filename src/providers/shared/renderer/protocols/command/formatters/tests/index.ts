import type { CommandFormatter } from '@providers/shared/renderer/protocols/command/formatters/types'

// Test-runner totals (vitest/jest vocabulary). Multiple DISTINCT summary
// sets decline — a watch-mode rerun or nested runners would double-count.
export const testTotalsFormatter: CommandFormatter = {
  id: 'test-totals',
  conclude({ command, plainOutput }) {
    // A summary-looking line is not provenance. Arbitrary programs can print
    // "Tests 12 passed"; promoting that prose would fabricate a test result.
    // Only the runners that own the vocabulary below may synthesize a badge.
    if (!isVitestOrJestCommand(command)) return null
    const matches = [...plainOutput.matchAll(/^\s*(Tests|Test Files)\s*:?\s+(.+)$/gm)]
    if (matches.length === 0) return null
    const byLabel = new Map<string, Set<string>>()
    for (const m of matches) {
      // A heading beginning with "Tests" is ordinary English, not proof of a
      // runner total. Require the bounded Vitest/Jest summary vocabulary all
      // the way to end-of-line so prose such as "Tests are still running" or
      // "Tests 12 passed according to cache" cannot become a success badge.
      // Supporting a new runner should add its explicit grammar here; a broad
      // catch-all reverses the formatter's enrich-or-decline contract.
      if (!isTestSummaryValue(m[2].trim())) continue
      const set = byLabel.get(m[1]) ?? new Set<string>()
      set.add(m[2].trim())
      byLabel.set(m[1], set)
    }
    if (byLabel.size === 0) return null
    // Any label appearing with two DIFFERENT values = ambiguous → decline.
    for (const values of byLabel.values()) if (values.size > 1) return null
    return [...byLabel.entries()].map(([label, v]) => `${label}: ${[...v][0]}`).join(' · ')
  },
}

function isVitestOrJestCommand(command: string): boolean {
  // Command position matters: a substring check would admit `echo vitest`.
  // Compound commands decline because their output provenance is ambiguous.
  if (/[\n;&|]/.test(command)) return false
  const words = command.trim().match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map(word =>
    (word.startsWith('"') && word.endsWith('"')) || (word.startsWith("'") && word.endsWith("'"))
      ? word.slice(1, -1)
      : word,
  ) ?? []
  let index = 0
  while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index] ?? '')) index += 1
  if (['npx', 'bunx'].includes(words[index] ?? '')) index += 1
  const executable = (words[index] ?? '').split('/').at(-1)
  if (executable === 'vitest' || executable === 'jest') return true
  if (!['npm', 'pnpm', 'yarn', 'bun'].includes(executable ?? '')) return false
  const args = words.slice(index + 1)
  if (args[0] === 'exec') return args[1] === 'vitest' || args[1] === 'jest'
  // Package-manager test scripts are themselves explicit test-runner
  // commands even though package.json owns the final executable. Preserve the
  // useful conclusion for `npm test`/`pnpm run test:unit` while still denying
  // arbitrary programs that merely print a runner-shaped line.
  const script = args[0] === 'run' ? args[1] : args[0]
  return script === 'test' || script?.startsWith('test:') === true
}

function isTestSummaryValue(value: string): boolean {
  const item = String.raw`\d+\s+(?:failed|passed|skipped|pending|todo|total)(?:\s*\(\d+\))?`
  return new RegExp(`^${item}(?:(?:\\s*[|,]\\s*)${item})*$`, 'i').test(value)
}
