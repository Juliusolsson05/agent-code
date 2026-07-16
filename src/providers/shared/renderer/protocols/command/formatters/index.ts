import { stripAnsi } from '@shared/parsers/ansi'
import { fileMutationFormatter } from '@providers/shared/renderer/protocols/command/formatters/file-mutation'
import { jsonOutputFormatter } from '@providers/shared/renderer/protocols/command/formatters/json'
import { testTotalsFormatter } from '@providers/shared/renderer/protocols/command/formatters/tests'
import type {
  CommandFormatter,
  FormatterInput,
} from '@providers/shared/renderer/protocols/command/formatters/types'

// The formatter REGISTRY (product-owner structure): one DIRECTORY per
// command family (dir-per-component convention, 2026-07-16 — a family owns
// its dir even while it is one file, so fixtures/sub-parsers land beside it
// instead of bloating a flat sibling list), registered here in priority
// order — first non-decline wins. New families (git/, diagnostics/, build
// tools…) are one new directory + one line here; adding one never touches
// another's logic.
export const COMMAND_FORMATTERS: readonly CommandFormatter[] = [
  testTotalsFormatter,
  jsonOutputFormatter,
  fileMutationFormatter,
]

const ANALYZE_CAP = 200_000

/** Run the registry over a command's TERMINAL output. Returns the winning
 *  conclusion line or null when every formatter declines. */
export function analyzeCommandOutput(
  command: string,
  rawOutput: string,
  exitCode: number | null,
): string | null {
  const wasCapped = rawOutput.length > ANALYZE_CAP
  const input: FormatterInput = {
    command,
    plainOutput: stripAnsi(wasCapped ? rawOutput.slice(0, ANALYZE_CAP) : rawOutput),
    wasCapped,
    exitCode,
  }
  for (const formatter of COMMAND_FORMATTERS) {
    const conclusion = formatter.conclude(input)
    if (conclusion) return conclusion
  }
  return null
}
