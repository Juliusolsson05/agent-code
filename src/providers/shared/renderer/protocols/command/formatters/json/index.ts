import type { CommandFormatter } from '@providers/shared/renderer/protocols/command/formatters/types'

// Complete-JSON conclusion: objects/arrays only, and only when the WHOLE
// payload was available — a capped payload cannot prove completeness.
export const jsonOutputFormatter: CommandFormatter = {
  id: 'json-output',
  conclude({ plainOutput, wasCapped }) {
    if (wasCapped) return null
    const trimmed = plainOutput.trim()
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null
    try {
      const parsed: unknown = JSON.parse(trimmed)
      if (typeof parsed !== 'object' || parsed === null) return null
      return Array.isArray(parsed)
        ? `JSON output (${parsed.length} item${parsed.length === 1 ? '' : 's'})`
        : `JSON output (${Object.keys(parsed).length} key${Object.keys(parsed).length === 1 ? '' : 's'})`
    } catch {
      return null
    }
  },
}
