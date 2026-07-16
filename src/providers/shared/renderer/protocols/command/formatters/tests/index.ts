import type { CommandFormatter } from '@providers/shared/renderer/protocols/command/formatters/types'

// Test-runner totals (vitest/jest vocabulary). Multiple DISTINCT summary
// sets decline — a watch-mode rerun or nested runners would double-count.
export const testTotalsFormatter: CommandFormatter = {
  id: 'test-totals',
  conclude({ plainOutput }) {
    const matches = [...plainOutput.matchAll(/^\s*(Tests|Test Files)\s*:?\s+(.+)$/gm)]
    if (matches.length === 0) return null
    const byLabel = new Map<string, Set<string>>()
    for (const m of matches) {
      const set = byLabel.get(m[1]) ?? new Set<string>()
      set.add(m[2].trim())
      byLabel.set(m[1], set)
    }
    // Any label appearing with two DIFFERENT values = ambiguous → decline.
    for (const values of byLabel.values()) if (values.size > 1) return null
    return [...byLabel.entries()].map(([label, v]) => `${label}: ${[...v][0]}`).join(' · ')
  },
}
