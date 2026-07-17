import type { ToolResultBlock, ToolUseBlock } from '@shared/types/transcript'
import type { SemanticLiveTurn } from '@renderer/session-runtime/state'

import type { WorkflowRunReference } from '../client/WorkflowClient'

const MAX_PARSE_DEPTH = 7
const MAX_VISITED_NODES = 160
const MAX_TEXT_BYTES = 256_000

export function isWorkflowRunToolName(name: string | null | undefined): boolean {
  if (!name) return false
  const normalized = name.trim().toLowerCase()
  return (
    normalized === 'workflow_run' ||
    normalized === 'mcp__agent_code__workflow_run'
  )
}

export function isWorkflowResumeToolName(name: string | null | undefined): boolean {
  if (!name) return false
  const normalized = name.trim().toLowerCase()
  return (
    normalized === 'workflow_resume' ||
    normalized === 'mcp__agent_code__workflow_resume'
  )
}

export function isWorkflowViewToolName(name: string | null | undefined): boolean {
  return isWorkflowRunToolName(name) || isWorkflowResumeToolName(name)
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function referenceFromRecord(record: Record<string, unknown>): WorkflowRunReference | null {
  if (typeof record.runId !== 'string' || record.runId.length === 0) return null
  const workflowRecord = asRecord(record.workflow)
  const workflow = workflowRecord && typeof workflowRecord.name === 'string'
    ? {
        name: workflowRecord.name,
        ...(typeof workflowRecord.title === 'string' ? { title: workflowRecord.title } : {}),
        ...(typeof workflowRecord.description === 'string'
          ? { description: workflowRecord.description }
          : {}),
      }
    : undefined
  return {
    runId: record.runId,
    ...(typeof record.cwd === 'string' ? { cwd: record.cwd } : {}),
    ...(typeof record.status === 'string' ? { status: record.status } : {}),
    ...(typeof record.cursor === 'number' && Number.isFinite(record.cursor)
      ? { cursor: record.cursor }
      : {}),
    ...(workflow ? { workflow } : {}),
    ...(typeof record.resumedFromRunId === 'string'
      ? { resumedFromRunId: record.resumedFromRunId }
      : {}),
  }
}

function balancedJsonCandidates(text: string): string[] {
  const candidates: string[] = []
  let start = -1
  let depth = 0
  let quoted = false
  let escaped = false

  // Provider adapters sometimes decorate an MCP result with timing/debug text. A blanket
  // `slice(firstBrace,lastBrace)` breaks the moment that wrapper contains two JSON values. This
  // small scanner extracts each balanced top-level value and respects quoted braces, so the
  // actual structured result remains recoverable without accepting arbitrary JavaScript syntax.
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (quoted) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') quoted = false
      continue
    }
    if (char === '"') {
      quoted = true
      continue
    }
    if (char === '{' || char === '[') {
      if (depth === 0) start = index
      depth += 1
      continue
    }
    if (char === '}' || char === ']') {
      if (depth === 0) continue
      depth -= 1
      if (depth === 0 && start >= 0) {
        candidates.push(text.slice(start, index + 1))
        start = -1
      }
    }
  }
  return candidates
}

function parsedTextValues(text: string): unknown[] {
  const bounded = text.slice(0, MAX_TEXT_BYTES).trim()
  if (!bounded) return []
  const values: unknown[] = []
  try {
    values.push(JSON.parse(bounded))
  } catch {
    for (const candidate of balancedJsonCandidates(bounded)) {
      try {
        values.push(JSON.parse(candidate))
      } catch {
        // A malformed diagnostic fragment is expected provider residue. Other balanced candidates
        // may still contain the real MCP payload, so one miss must not abort the scan.
      }
    }
  }
  return values
}

/**
 * Locate the stable workflow launch envelope inside Claude and Codex result wrappers.
 *
 * MCP clients currently disagree about whether structured content is preserved as an object,
 * nested under `structuredContent`, or serialized into the first text content item. A bounded
 * breadth-first walk accepts those equivalent envelopes while refusing an unbounded recursive
 * parse of provider-controlled output. The contract remains strict at the leaf: only `runId`
 * creates a workflow card.
 */
export function parseWorkflowRunReference(value: unknown): WorkflowRunReference | null {
  const queue: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }]
  const seen = new Set<object>()
  let visited = 0

  while (queue.length > 0 && visited < MAX_VISITED_NODES) {
    const current = queue.shift()!
    visited += 1
    if (current.depth > MAX_PARSE_DEPTH || current.value == null) continue

    if (typeof current.value === 'string') {
      for (const parsed of parsedTextValues(current.value)) {
        queue.push({ value: parsed, depth: current.depth + 1 })
      }
      continue
    }
    if (typeof current.value !== 'object') continue
    if (seen.has(current.value)) continue
    seen.add(current.value)

    if (Array.isArray(current.value)) {
      for (const item of current.value) {
        const itemRecord = asRecord(item)
        // Anthropic/MCP content arrays carry JSON in `{type:'text', text:'...'}`. Prioritize the
        // text member so a large unrelated image/content item cannot consume the node budget first.
        if (itemRecord && typeof itemRecord.text === 'string') {
          queue.unshift({ value: itemRecord.text, depth: current.depth + 1 })
        } else {
          queue.push({ value: item, depth: current.depth + 1 })
        }
      }
      continue
    }

    const record = current.value as Record<string, unknown>
    const direct = referenceFromRecord(record)
    if (direct) return direct

    // Known MCP/provider envelopes go first. The all-values fallback is deliberate: Codex and
    // Claude have each added one wrapper layer in the past, but the bounded walk and strict leaf
    // keep compatibility from becoming an arbitrary deep object search.
    for (const key of ['run', 'structuredContent', 'structured_content', 'result', 'output', 'content', 'data']) {
      if (record[key] !== undefined) {
        queue.push({ value: record[key], depth: current.depth + 1 })
      }
    }
    for (const nested of Object.values(record)) {
      if (nested !== undefined) queue.push({ value: nested, depth: current.depth + 1 })
    }
  }
  return null
}

export function parseWorkflowToolResult(
  result: ToolResultBlock | null | undefined,
): WorkflowRunReference | null {
  return result ? parseWorkflowRunReference(result.content) : null
}

export type WorkflowRunReferenceSources = {
  toolUseIndex: ReadonlyMap<string, ToolUseBlock>
  toolResultIndex: ReadonlyMap<string, ToolResultBlock>
  semanticTurns: readonly SemanticLiveTurn[]
}

/**
 * Recover workflow runs from the session runtime without asking the feed renderer to own them.
 *
 * WHY both transcript indexes and semantic turns are scanned: the semantic plane sees an MCP
 * result first, while the durable transcript can trail it by several provider turns. Relying on
 * only one source either delays the workflow row or makes it disappear during reconciliation.
 * De-duplicating by durable runId lets both planes overlap safely and keeps the first-seen order
 * stable for the vertical view selector.
 */
export function collectWorkflowRunReferences({
  toolUseIndex,
  toolResultIndex,
  semanticTurns,
}: WorkflowRunReferenceSources): WorkflowRunReference[] {
  const references = new Map<string, WorkflowRunReference>()
  const remember = (reference: WorkflowRunReference | null): void => {
    if (!reference) return
    const previous = references.get(reference.runId)
    references.set(reference.runId, {
      ...previous,
      ...reference,
      ...(reference.workflow ?? previous?.workflow
        ? { workflow: reference.workflow ?? previous?.workflow }
        : {}),
    })
  }

  for (const [toolUseId, toolUse] of toolUseIndex) {
    if (!isWorkflowViewToolName(toolUse.name)) continue
    const result = toolResultIndex.get(toolUseId)
    if (!result || result.is_error === true) continue
    remember(parseWorkflowToolResult(result))
  }

  for (const turn of semanticTurns) {
    for (const blockIndex of turn.blockOrder) {
      const block = turn.blocks[blockIndex]
      if (!block || !isWorkflowViewToolName(block.toolName) || block.resultIsError) continue
      const correlationId = block.toolUseId ?? block.callId ?? block.itemId
      const toolState = correlationId ? turn.lookups.toolCallsById[correlationId] : undefined
      if (toolState?.status === 'error') continue
      remember(parseWorkflowRunReference(
        block.resultContent ?? toolState?.resultContent ?? block.output,
      ))
    }
  }

  return [...references.values()]
}
