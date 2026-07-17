import { useState } from 'react'

import { MarkerRow } from '@renderer/features/feed/ui/MarkerRow'
import { CodeBlock } from '@renderer/lib/code/CodeBlock'
import { boundedJsonPreview } from '@renderer/lib/text/boundedJson'
import { PagedTextViewer } from '@renderer/lib/text/PagedTextViewer'
import { isHttpUrl } from '@providers/shared/renderer/rows/jsonToolPresentation'
import {
  base64MediaDataUrl,
  parseBase64MediaPreview,
} from '@providers/shared/renderer/protocols/media/base64'
import { asRecord } from '@shared/lib/asRecord'

import {
  mcpContentCounts,
  type McpContentBlock,
  type McpContentModel,
} from './model'

function shortText(value: string, max = 140): string {
  const firstLine = value.slice(0, max).split('\n', 1)[0]
  return value.length > firstLine.length ? `${firstLine}…` : firstLine
}

function LazyJson({ value, label = 'View typed block' }: { value: unknown; label?: string }) {
  const [open, setOpen] = useState(false)
  return (
    <details className="text-[11px] text-muted" onToggle={event => setOpen(event.currentTarget.open)}>
      <summary className="cursor-pointer select-none">{label}</summary>
      {open ? (
        <div className="mt-1">
          <CodeBlock code={boundedJsonPreview(value) ?? '(unavailable)'} language="json" />
        </div>
      ) : null}
    </details>
  )
}

function McpBlockView({ block }: { block: McpContentBlock }) {
  const [open, setOpen] = useState(false)
  const value = block.value

  if (block.type === 'resource_link') {
    const uri = typeof value.uri === 'string' ? value.uri : ''
    const rawName = typeof value.title === 'string'
      ? value.title
      : typeof value.name === 'string' ? value.name : uri || 'Resource link'
    const name = shortText(rawName, 280)
    return (
      <div className="rounded border border-border/70 px-2 py-1.5 text-[12px]">
        <div className="text-ink-dim">Resource link</div>
        {isHttpUrl(uri) ? (
          <a href={uri} target="_blank" rel="noreferrer" className="text-accent hover:underline break-all">
            {name}
          </a>
        ) : <div className="font-code text-ink break-all">{name}</div>}
        {typeof value.description === 'string' ? (
          <div className="mt-0.5 text-[11px] text-muted">{shortText(value.description, 500)}</div>
        ) : null}
      </div>
    )
  }

  const resource = block.type === 'resource' ? asRecord(value.resource) : null
  const text = block.type === 'text' && typeof value.text === 'string'
    ? value.text
    : typeof resource?.text === 'string' ? resource.text : null
  const mediaKind = block.type === 'image' || block.type === 'audio' ? block.type : null
  const media = mediaKind
    ? parseBase64MediaPreview(mediaKind, value.mimeType, value.data)
    : null
  const resourceUri = typeof resource?.uri === 'string' ? resource.uri : null
  const label = text !== null
    ? shortText(text) || '(empty text)'
    : mediaKind
      ? `${mediaKind} · ${typeof value.mimeType === 'string' ? value.mimeType : 'unknown type'}`
      : resourceUri
        ? `resource · ${shortText(resourceUri, 280)}`
        : block.type.replace(/_/g, ' ')

  return (
    <details
      className="rounded border border-border/70 px-2 py-1 text-[12px] text-ink-dim"
      onToggle={event => setOpen(event.currentTarget.open)}
    >
      <summary className="cursor-pointer select-none break-all">{label}</summary>
      {open ? (
        <div className="mt-2 space-y-2">
          {text !== null ? <PagedTextViewer source={text} /> : null}
          {block.type === 'image' ? (
            media ? (
              <img src={base64MediaDataUrl(media)} alt="MCP image result" className="max-h-[420px] max-w-full rounded border border-border object-contain" />
            ) : (
              <div className="text-[11px] text-muted">Image preview unavailable or above the 8 MiB inline-media budget.</div>
            )
          ) : null}
          {block.type === 'audio' ? (
            media ? (
              <audio controls preload="none" src={base64MediaDataUrl(media)} className="max-w-full" />
            ) : (
              <div className="text-[11px] text-muted">Audio preview unavailable or above the 8 MiB inline-media budget.</div>
            )
          ) : null}
          {resource && typeof resource.blob === 'string' ? (
            <div className="text-[11px] text-muted">
              Binary resource · {resource.blob.length.toLocaleString()} encoded characters
            </div>
          ) : null}
          <LazyJson value={value} />
        </div>
      ) : null}
    </details>
  )
}

function ExactMcpSource({ raw, source, isError }: { raw: unknown; source?: string; isError: boolean }) {
  const [open, setOpen] = useState(false)
  let resolvedSource: string | null = null
  if (open) {
    try {
      resolvedSource = source ?? (typeof raw === 'string' ? raw : JSON.stringify(raw, null, 2))
    } catch {
      resolvedSource = null
    }
  }
  return (
    <details className="text-[11px] text-muted" onToggle={event => setOpen(event.currentTarget.open)}>
      <summary className="cursor-pointer select-none">View exact MCP result</summary>
      {open ? (
        <div className="mt-1 rounded border border-border bg-surface px-2 py-1.5">
          {resolvedSource === null ? 'Exact result unavailable.' : <PagedTextViewer source={resolvedSource} isError={isError} />}
        </div>
      ) : null}
    </details>
  )
}

export function McpContentView({
  model,
  source,
  transportError = false,
}: {
  model: McpContentModel
  /** Exact transport bytes when the caller has them. Direct typed arrays have
   * no serialized source and intentionally fall back to the model's raw value. */
  source?: string
  transportError?: boolean
}) {
  const danger = transportError || model.isError
  return (
    <MarkerRow marker="⎿" tone="muted">
      <div className="w-full min-w-0 space-y-2">
        <div className={danger ? 'text-danger text-[12px]' : 'text-ink-dim text-[12px]'}>
          MCP result · {mcpContentCounts(model)}
        </div>
        <div className="space-y-1">
          {model.blocks.map((block, index) => (
            <McpBlockView key={`${index}:${block.type}`} block={block} />
          ))}
        </div>
        {model.blocks.length < model.totalBlocks ? (
          <div className="text-[11px] text-muted">Additional typed blocks are preserved in the exact result.</div>
        ) : null}
        {model.structuredContent !== undefined ? (
          <LazyJson label="Structured content" value={model.structuredContent} />
        ) : null}
        {model.metadata ? <LazyJson label="MCP metadata" value={model.metadata} /> : null}
        <ExactMcpSource raw={model.raw} source={source} isError={danger} />
      </div>
    </MarkerRow>
  )
}
