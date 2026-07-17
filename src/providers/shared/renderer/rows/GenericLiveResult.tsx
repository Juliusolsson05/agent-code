import { memo, useMemo } from 'react'

import { TruncatedOutputRow } from '@renderer/features/feed/ui/rows/TruncatedOutputRow'
import { OutputWell } from '@renderer/lib/text/OutputWell'
import { StructuredOutputView } from '@providers/shared/renderer/protocols/structured-output/StructuredOutputView'
import { parseStructuredOutput } from '@providers/shared/renderer/protocols/structured-output/model'
import { McpContentView } from '@providers/shared/renderer/protocols/mcp-content/McpContentView'
import {
  isMcpContentCarrier,
  parseMcpContentResult,
} from '@providers/shared/renderer/protocols/mcp-content/model'

import { JsonResultSlab } from './JsonResultSlab'
import { tryExtractJson } from './jsonToolPresentation'

/** The one semantic/live result fallback used by every provider.
 *
 * WHY this is outside the central feed: output grammar is shared, while the
 * decision that a provider-specific result parser declined belongs to the
 * provider dispatcher. Both paths must converge here or the same MCP/JSONL
 * response changes presentation at transcript commit time. */
export const GenericLiveResult = memo(function GenericLiveResult({
  source,
  isError,
  allowDirectMcpArray = false,
  textFallback = 'truncated',
}: {
  source: string
  isError: boolean
  allowDirectMcpArray?: boolean
  textFallback?: 'truncated' | 'output-well'
}) {
  const presentation = useMemo(() => {
    const json = tryExtractJson(source)
    const mcp = parseMcpContentResult(source, { allowDirectArray: allowDirectMcpArray })
    const ownsMcp = mcp !== null && (
      isMcpContentCarrier(json) || (allowDirectMcpArray && Array.isArray(json))
    )
    return {
      json: !ownsMcp && json !== null && typeof json === 'object' ? json : null,
      mcp: ownsMcp ? mcp : null,
      structured: ownsMcp || (json !== null && typeof json === 'object')
        ? null
        : parseStructuredOutput(source),
    }
  }, [allowDirectMcpArray, source])

  if (presentation.json !== null) {
    return <JsonResultSlab value={presentation.json} isError={isError} source={source} />
  }
  if (presentation.mcp !== null) {
    return <McpContentView model={presentation.mcp} source={source} transportError={isError} />
  }
  if (presentation.structured !== null) {
    return (
      <StructuredOutputView
        model={presentation.structured}
        source={source}
        isError={isError}
      />
    )
  }
  return textFallback === 'output-well'
    ? <OutputWell text={source} isError={isError} />
    : <TruncatedOutputRow content={source} isError={isError} />
})
