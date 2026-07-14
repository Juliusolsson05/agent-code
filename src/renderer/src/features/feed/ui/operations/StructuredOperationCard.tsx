import { memo, type ReactNode } from 'react'

import { formatToolFilePath } from '@shared/paths/displayPath'
import {
  isAbsolutePathLike,
  slabEntries,
  smartHeadline,
} from '@providers/shared/renderer/rows/jsonToolPresentation'

import { MarkerRow } from '@renderer/features/feed/ui/MarkerRow'
import { CodeBlock } from '@renderer/lib/code/CodeBlock'
import { ExpandSection } from '@renderer/features/feed/ui/kit/ExpandSection'
import { StatusBadge, type BadgeStatus } from '@renderer/features/feed/ui/kit/StatusBadge'
import {
  StructuredOutput,
  StructuredScalar,
} from '@renderer/features/feed/ui/kit/StructuredOutput'

const SLAB_MAX_CHARS = 16 * 1024

// This is the structured fallback, not a second dispatch system. Dedicated
// command/diff/read cards still own their rich domain UI; every long-tail
// operation (MCP, collaboration, plan/workspace actions, future provider
// tools) can use this one stable surface without teaching React its wire
// protocol. The props intentionally use strings and unknown records rather
// than projection types so the projector can adapt into the card without a
// dependency cycle.

export type StructuredOperationStatus = BadgeStatus
export type StructuredOperationFamily = string

export type StructuredOperationMetadata = {
  label: string
  value: string
  title?: string
}

export type StructuredOperationCardProps = {
  id: string
  family: StructuredOperationFamily
  toolName: string
  displayName?: string | null
  status: StructuredOperationStatus
  summary?: string | null
  params?: Record<string, unknown> | null
  /** Unparsed provider input. It is intentionally never painted directly;
   *  it exists only for the explicit source/debug disclosure. */
  rawInput?: string | null
  parseError?: string | null
  result?: unknown
  resultIsError?: boolean
  server?: string | null
  metadata?: readonly StructuredOperationMetadata[]
  marker?: string
}

function familyLabel(family: string): string | null {
  const labels: Record<string, string> = {
    collaboration: 'collaboration',
    'task-plan': 'task / plan',
    question: 'user input',
    mcp: 'MCP',
    notebook: 'notebook',
    'code-intelligence': 'code intelligence',
    'skill-workflow': 'workflow',
    workspace: 'workspace',
    preparing: 'preparing',
  }
  return labels[family] ?? (family === 'generic' ? null : family.replace(/[-_]+/g, ' '))
}

function humanizeToolName(name: string): string {
  // Preserve short all-caps names such as LSP/MCP. Everything else benefits
  // from losing transport spelling (`update_plan`, `requestUserInput`) while
  // retaining the original name in the title attribute for debugging.
  if (/^[A-Z0-9]{2,8}$/.test(name)) return name
  const spaced = name
    .replace(/^mcp__[^]*__/, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[-_]+/g, ' ')
    .trim()
  if (!spaced) return name
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

function headlineText(value: string): string {
  return isAbsolutePathLike(value) ? formatToolFilePath(value, null) : value
}

function ParamsDisclosure({
  params,
  headlineKey,
  operationId,
}: {
  params: Record<string, unknown>
  headlineKey: string | null
  operationId: string
}) {
  const entries = slabEntries(params, headlineKey)
  if (entries.length === 0) return null
  const scalar = entries.filter(([, value]) => value === null || typeof value !== 'object')
  const nested = entries.filter(([, value]) => value !== null && typeof value === 'object')

  return (
    <MarkerRow marker="⎿" tone="muted">
      <ExpandSection summary={`${entries.length} parameter${entries.length === 1 ? '' : 's'}`}>
        <div className="space-y-1">
          {scalar.map(([key, value]) => (
            <div
              key={key}
              className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-2 text-[12px] leading-[1.55]"
            >
              <span className="font-code text-muted">{key}</span>
              <span className="min-w-0 text-ink-dim"><StructuredScalar value={value} /></span>
            </div>
          ))}
          {nested.length > 0 ? (
            <NestedParams entries={nested} operationId={operationId} />
          ) : null}
        </div>
      </ExpandSection>
    </MarkerRow>
  )
}

function NestedParams({
  entries,
  operationId,
}: {
  entries: Array<[string, unknown]>
  operationId: string
}) {
  let json: string | null = null
  try {
    json = JSON.stringify(Object.fromEntries(entries), null, 2)
  } catch {
    json = null
  }
  return json ? (
    <CodeBlock
      code={json}
      language="json"
      codeId={`operation-params:${operationId}`}
      highlight={json.length <= SLAB_MAX_CHARS}
    />
  ) : (
    <div className="text-muted">Nested parameters cannot be serialized.</div>
  )
}

function SourceInputDisclosure({
  rawInput,
  operationId,
}: {
  rawInput: string
  operationId: string
}) {
  return (
    <MarkerRow marker="⎿" tone="muted">
      <ExpandSection summary="Source input (debug)">
        {/* The disclosure itself is lazy, so retain exact provider bytes here.
            Capping a debug surface destroys the evidence needed to diagnose a
            partial parser; large inputs merely skip syntax highlighting. */}
        <CodeBlock
          code={rawInput}
          language="json"
          codeId={`operation-source:${operationId}`}
          highlight={rawInput.length <= SLAB_MAX_CHARS}
        />
      </ExpandSection>
    </MarkerRow>
  )
}

function Metadata({ items }: { items: readonly StructuredOperationMetadata[] }) {
  if (items.length === 0) return null
  return (
    <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-muted">
      {items.map(item => (
        <span key={`${item.label}:${item.value}`} title={item.title}>
          {item.label}: {item.value}
        </span>
      ))}
    </div>
  )
}

function HeaderBadge({ children }: { children: ReactNode }) {
  return (
    <span className="text-[11px] text-ink-dim border border-border rounded px-1 py-px align-middle">
      {children}
    </span>
  )
}

export const StructuredOperationCard = memo(function StructuredOperationCard({
  id,
  family,
  toolName,
  displayName,
  status,
  summary,
  params = null,
  rawInput = null,
  parseError = null,
  result,
  resultIsError = false,
  server = null,
  metadata = [],
  marker = '⏺',
}: StructuredOperationCardProps) {
  const inferredHeadline = smartHeadline(params)
  const shownSummary = summary ?? inferredHeadline?.value ?? null
  const receiving =
    params === null &&
    (status === 'streaming' || status === 'running') &&
    (rawInput !== null || status === 'streaming')
  const badge = familyLabel(family)
  const shownName = displayName?.trim() || humanizeToolName(toolName)

  return (
    <MarkerRow marker={marker}>
      <div data-structured-operation={id}>
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-[13px] leading-[1.65]">
          <span className="text-accent font-semibold" title={toolName}>{shownName}</span>
          {server ? <HeaderBadge>MCP · {server}</HeaderBadge> : badge ? <HeaderBadge>{badge}</HeaderBadge> : null}
          <StatusBadge status={status} />
        </div>

        {shownSummary ? (
          <MarkerRow marker="⎿" tone="muted">
            <div className="font-code text-[12px] leading-[1.55] text-ink-dim whitespace-pre-wrap break-all">
              {headlineText(shownSummary)}
            </div>
          </MarkerRow>
        ) : null}

        <Metadata items={metadata} />

        {receiving ? (
          <MarkerRow marker="⎿" tone="muted">
            <span className="text-[12px] text-muted animate-pulse">Receiving parameters…</span>
          </MarkerRow>
        ) : params ? (
          <ParamsDisclosure
            params={params}
            headlineKey={inferredHeadline?.key ?? null}
            operationId={id}
          />
        ) : null}

        {/* Raw protocol text is useful when a provider is malformed, but it is
            never the operation itself. Keeping it behind an explicitly debug-
            labelled disclosure prevents a half-received JSON string from
            replacing the user's actual story of what the agent is doing. */}
        {rawInput ? <SourceInputDisclosure rawInput={rawInput} operationId={id} /> : null}

        {parseError && status !== 'streaming' ? (
          <MarkerRow marker="⎿" tone="muted">
            <span className="text-danger text-[12px] leading-[1.55]">
              Parameters could not be structured: {parseError}
            </span>
          </MarkerRow>
        ) : null}

        {result !== undefined && result !== null ? (
          <StructuredOutput
            value={result}
            isError={resultIsError || status === 'error'}
            codeId={`operation-result:${id}`}
          />
        ) : null}
      </div>
    </MarkerRow>
  )
})
