import { trimSemanticId } from '@renderer/workspace/semantic/helpers'

// One-line summaries for the proxy debug panel event tail + the
// feed-debug log SEM layer. Both surfaces render tens of lines at
// once; compact, copy/pasteable strings beat raw JSON for triage.
// `summarizeSemanticEvent` is the terse column-oriented view;
// `summarizeSemanticEventForDebug` is the verbose sidebar view that
// includes routing info (turnId / blockIndex / toolName / source /
// stopReason).

export function summarizeSemanticEvent(ev: Record<string, unknown>): string {
  const t = String(ev.type ?? '')
  switch (t) {
    case 'turn_started':
      return `turn_started ${trimSemanticId(ev.turnId)} (${ev.source ?? '?'})`
    case 'turn_delta': {
      const ft = typeof ev.fullText === 'string' ? ev.fullText : ''
      return `turn_delta len=${ft.length}`
    }
    case 'text_delta':
      return `text_delta idx=${ev.blockIndex} +${String(ev.textDelta ?? '').length}`
    case 'thinking_delta':
      return `thinking_delta idx=${ev.blockIndex} +${String(ev.thinkingDelta ?? '').length}`
    case 'connector_text_delta':
      return `connector_text_delta idx=${ev.blockIndex} +${String(ev.connectorTextDelta ?? '').length}`
    case 'citations_delta':
      return `citations_delta idx=${ev.blockIndex}`
    case 'tool_input_delta':
      return `tool_input_delta idx=${ev.blockIndex} ${ev.toolName ?? '?'}`
    case 'tool_input_finalized':
      return `tool_input_finalized idx=${ev.blockIndex} ${ev.toolName ?? '?'} ${ev.parsed ? '[ok]' : '[bad]'}`
    case 'block_started':
      return `block_started idx=${ev.blockIndex} ${ev.kind}${ev.toolName ? ` (${ev.toolName})` : ''}`
    case 'block_completed':
      return `block_completed idx=${ev.blockIndex} ${ev.kind}`
    case 'turn_stopped':
      return `turn_stopped ${ev.stopReason ?? '?'}`
    case 'turn_completed':
      return 'turn_completed'
    case 'usage_updated': {
      const u = ev.usage as Record<string, unknown> | undefined
      return `usage in=${u?.input_tokens ?? '?'} out=${u?.output_tokens ?? '?'}`
    }
    case 'flow_selected':
      return `flow_selected ${ev.flowId} — ${ev.reason}`
    case 'flow_ignored':
      return `flow_ignored ${ev.flowId} — ${ev.reason}`
    case 'api_error':
      return `api_error ${ev.errorType ?? ''} — ${String(ev.message ?? '').slice(0, 60)}`
    case 'stream_error':
      return `stream_error ${ev.errorType ?? ''} — ${String(ev.message ?? '').slice(0, 60)}`
    case 'source_changed':
      return `source_changed ${ev.previousSource ?? '?'} → ${ev.source ?? '?'}`
    case 'signature':
      return `signature idx=${ev.blockIndex}`
    case 'tool_result':
      return `tool_result ${trimSemanticId(ev.toolUseId)} ${ev.isError ? '[error]' : ''}`
    case 'tool_started':
      return `tool_started ${trimSemanticId(ev.callId)} ${String(ev.label ?? ev.tool ?? '')}`.trim()
    case 'tool_output_delta':
      return `tool_output_delta ${trimSemanticId(ev.callId)} +${String(ev.textDelta ?? '').length}`
    case 'tool_completed':
      return `tool_completed ${trimSemanticId(ev.callId)} exit=${String(ev.exitCode ?? '-')}`
    default:
      return t
  }
}

/** Verbose summary used in the SEM layer of the feed-debug log. */
export function summarizeSemanticEventForDebug(event: Record<string, unknown>): string {
  const type = typeof event.type === 'string' ? event.type : 'unknown'
  const turnId = typeof event.turnId === 'string' ? event.turnId : null
  const source = typeof event.source === 'string' ? event.source : null
  const toolName = typeof event.toolName === 'string' ? event.toolName : null
  const blockIndex =
    typeof event.blockIndex === 'number' ? event.blockIndex : null
  const stopReason =
    typeof event.stopReason === 'string' ? event.stopReason : null
  const parts = [type]
  if (source) parts.push(`src=${source}`)
  if (turnId) parts.push(`turn=${turnId.slice(0, 10)}`)
  if (blockIndex !== null) parts.push(`block=${blockIndex}`)
  if (toolName) parts.push(`tool=${toolName}`)
  if (stopReason) parts.push(`stop=${stopReason}`)
  return parts.join(' ')
}
