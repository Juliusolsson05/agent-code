import { memo, type ReactNode } from 'react'

import { formatToolFilePath } from '@shared/paths/displayPath'
import {
  isAbsolutePathLike,
  isHttpUrl,
  tryExtractJson,
} from '@providers/shared/renderer/rows/jsonToolPresentation'

import { MarkerRow } from '@renderer/features/feed/ui/MarkerRow'
import { CodeBlock } from '@renderer/lib/code/CodeBlock'
import { SafeMarkdownLink } from '@renderer/features/rendered-content/SafeMarkdownLink'

import { AnsiText } from './AnsiText'
import { ExpandSection } from './ExpandSection'
import { OutputWell } from './OutputWell'

// Tool results are not uniformly "terminal output". MCP in particular returns
// typed content arrays, orchestration tools return compact JSON records, and
// command-like fallbacks return ANSI text. Flattening all three into a <pre>
// throws away the structure the provider already gave us. This component is
// the deliberately small interpretation boundary: it recognizes only stable,
// user-helpful shapes and leaves everything else available as collapsed JSON.
// It does NOT know about providers or operation families, which keeps it usable
// by both the generic fallback and the unified operation row.

const JSON_PREVIEW_MAX_CHARS = 16 * 1024
const TEXT_MAX_CHARS = 200_000
const SCALAR_PREVIEW_MAX_CHARS = 600
// Building a data: URL duplicates the base64 string in renderer memory and then
// asks Chromium to decode it. A provider can otherwise turn one tool result into
// a multi-hundred-megabyte allocation before the user has even looked at the
// image. Four MiB encoded is enough for normal tool thumbnails while keeping the
// worst-case decoded raster and duplicate URL bounded.
export const MCP_INLINE_IMAGE_MAX_BASE64_CHARS = 4 * 1024 * 1024

type UnknownRecord = Record<string, unknown>

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function safeJson(value: unknown): string | null {
  try {
    const json = JSON.stringify(value, null, 2)
    if (typeof json !== 'string') return null
    // JsonBody mounts only after the user opens its disclosure. Preserve the
    // complete serialization there; a 16 KiB cut labelled "Complete result"
    // is a data-loss bug, not progressive disclosure. Large sources simply
    // skip highlight.js below to keep the deliberate expansion bounded in CPU.
    return json
  } catch {
    // A tool result is external input. Circular values and BigInts should make
    // the debug expansion unavailable, not take down the entire feed row.
    return null
  }
}

function resultLabel(value: unknown): string {
  if (Array.isArray(value)) return `${value.length} item${value.length === 1 ? '' : 's'}`
  if (isRecord(value)) {
    if (value.ok === false) return 'Failed'
    if (value.ok === true) return 'Completed'
    const count = Object.keys(value).length
    return `${count} field${count === 1 ? '' : 's'}`
  }
  return 'Result'
}

/** Render a scalar as information rather than syntax. Whole-value URL/path
 * recognition is intentional: linkifying arbitrary prose around punctuation
 * produces broken targets, and ANSI token spans make that heuristic even less
 * reliable. Structured fields already give us the exact value boundary. */
export function StructuredScalar({ value }: { value: unknown }) {
  if (typeof value === 'string') {
    if (isHttpUrl(value)) {
      return (
        <SafeMarkdownLink
          href={value}
          className="text-accent underline break-all"
        >
          {value}
        </SafeMarkdownLink>
      )
    }
    if (isAbsolutePathLike(value)) {
      return (
        <span title={value} className="font-code break-all">
          {formatToolFilePath(value, null)}
        </span>
      )
    }
    return (
      <span className="whitespace-pre-wrap break-words">
        {value.length > SCALAR_PREVIEW_MAX_CHARS
          ? `${value.slice(0, SCALAR_PREVIEW_MAX_CHARS)}…`
          : value}
      </span>
    )
  }
  if (value === null) return <span className="text-muted">null</span>
  if (typeof value === 'boolean') return <span>{value ? 'true' : 'false'}</span>
  if (typeof value === 'number' || typeof value === 'bigint') {
    return <span className="font-code">{String(value)}</span>
  }
  if (typeof value === 'undefined') return <span className="text-muted">unknown</span>
  return <span className="text-muted">{Array.isArray(value) ? `[${value.length}]` : '{…}'}</span>
}

function JsonDisclosure({
  value,
  summary = 'Complete result',
  codeId,
}: {
  value: unknown
  summary?: ReactNode
  codeId?: string
}) {
  // ExpandSection delays both serialization and CodeBlock/Monaco mounting.
  // Dense restored feeds routinely contain hundreds of closed result slabs;
  // paying that cost before the user asks to inspect one is avoidable churn.
  return (
    <ExpandSection summary={summary}>
      <JsonBody value={value} codeId={codeId} />
    </ExpandSection>
  )
}

function ExactJsonSourceDisclosure({
  source,
  codeId,
}: {
  source: string
  codeId?: string
}) {
  return (
    <ExpandSection summary="Original JSON source (copyable)">
      {/* WHY this receives the original string rather than JSON.stringify(parsed):
          whitespace, key order, duplicate keys, numeric spelling, and escape
          sequences are evidence. Re-serialization is an interpretation, not a
          lossless fallback. CodeBlock also registers these exact bytes with the
          existing Copy Code Block command, while ExpandSection keeps a large
          source out of the DOM until someone explicitly asks for it. */}
      <CodeBlock
        code={source}
        language="json"
        codeId={codeId ? `${codeId}:original-json` : undefined}
        highlight={source.length <= JSON_PREVIEW_MAX_CHARS}
      />
    </ExpandSection>
  )
}

function JsonBody({ value, codeId }: { value: unknown; codeId?: string }) {
  const json = safeJson(value)
  if (json === null) {
    return <span className="text-muted">Result cannot be serialized.</span>
  }
  return (
    <CodeBlock
      code={json}
      language="json"
      codeId={codeId}
      highlight={json.length <= JSON_PREVIEW_MAX_CHARS}
    />
  )
}

function RecordPreview({
  value,
  isError,
  codeId,
}: {
  value: UnknownRecord
  isError: boolean
  codeId?: string
}) {
  const entries = Object.entries(value)
  const scalarEntries = entries.filter(([, item]) => item === null || typeof item !== 'object')
  // Six fields is enough to make a status/result understandable without
  // turning an operation into a database inspector. The disclosure below is
  // lossless and owns the full payload when more detail is useful.
  const visible = scalarEntries.slice(0, 6)
  const nestedCount = entries.length - scalarEntries.length

  return (
    <div className="space-y-1 text-[12px] leading-[1.55]">
      <div className={isError || value.ok === false ? 'text-danger' : 'text-ink-dim'}>
        {resultLabel(value)}
      </div>
      {visible.length > 0 ? (
        <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-2 gap-y-0.5">
          {visible.map(([key, item]) => (
            <div key={key} className="contents">
              <dt className="font-code text-muted">{key}</dt>
              <dd className="min-w-0 m-0 text-ink-dim">
                <StructuredScalar value={item} />
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
      <JsonDisclosure
        value={value}
        codeId={codeId}
        summary={
          nestedCount > 0 || scalarEntries.length > visible.length
            ? `Complete result · ${entries.length} fields`
            : 'Source result'
        }
      />
    </div>
  )
}

function ArrayPreview({
  value,
  codeId,
}: {
  value: unknown[]
  codeId?: string
}) {
  const scalarItems = value.filter(item => item === null || typeof item !== 'object')
  return (
    <div className="space-y-1 text-[12px] leading-[1.55] text-ink-dim">
      <div>{resultLabel(value)}</div>
      {scalarItems.length > 0 ? (
        <ul className="m-0 pl-4 space-y-0.5 list-disc">
          {scalarItems.slice(0, 6).map((item, index) => (
            // The provider did not give list members identities. Their ordinal
            // is therefore the only stable identity within an immutable result.
            <li key={index}><StructuredScalar value={item} /></li>
          ))}
        </ul>
      ) : null}
      <JsonDisclosure value={value} codeId={codeId} />
    </div>
  )
}

function textFromBlock(block: UnknownRecord): string | null {
  return typeof block.text === 'string' ? block.text : null
}

type McpImageSource =
  | { kind: 'inline'; data: string; mime: string; alt: string }
  | { kind: 'too-large'; encodedChars: number; alt: string }

function imageSource(block: UnknownRecord): McpImageSource | null {
  const source = isRecord(block.source) ? block.source : block
  const data = typeof source.data === 'string' ? source.data : null
  const mime =
    typeof source.media_type === 'string'
      ? source.media_type
      : typeof source.mimeType === 'string'
        ? source.mimeType
        : typeof source.mime_type === 'string'
          ? source.mime_type
          : null

  // SVG is intentionally excluded. Rendering provider-controlled SVG as an
  // image has a much larger active-content surface than the raster formats
  // generated by these tools. Unknown/remote images remain clickable metadata
  // rather than triggering an implicit network request from the feed.
  if (!data || !mime || !/^(image\/(?:png|jpeg|gif|webp|avif))$/i.test(mime)) return null

  const alt = typeof block.name === 'string' ? block.name : 'Tool result image'
  // Check the cheap bound BEFORE scanning base64 syntax. A hostile 100MB string
  // should be rejected in constant time rather than walked merely to decide it
  // is too expensive to preview.
  if (data.length > MCP_INLINE_IMAGE_MAX_BASE64_CHARS) {
    return { kind: 'too-large', encodedChars: data.length, alt }
  }
  if (/^[a-zA-Z0-9+/=\r\n]+$/.test(data)) {
    return { kind: 'inline', data, mime, alt }
  }
  return null
}

function LazyMcpImage({ image }: { image: Extract<McpImageSource, { kind: 'inline' }> }) {
  // This component is mounted only after ExpandSection opens. Keeping data-URL
  // construction in this child is load-bearing: creating the child element is
  // cheap, while concatenating and decoding megabytes of transport data is not.
  return (
    <img
      src={`data:${image.mime};base64,${image.data}`}
      alt={image.alt}
      loading="lazy"
      decoding="async"
      className="max-w-full max-h-[360px] rounded border border-border object-contain"
    />
  )
}

function McpImage({ block }: { block: UnknownRecord }) {
  const image = imageSource(block)
  if (!image) return <ResourceLink block={{ ...block, name: 'Image result' }} />
  if (image.kind === 'too-large') {
    return (
      <div className="text-[11px] text-muted" role="status">
        {image.alt} not previewed · {image.encodedChars.toLocaleString()} encoded characters
        {' '}({(MCP_INLINE_IMAGE_MAX_BASE64_CHARS / 1024 / 1024).toFixed(0)} MiB preview limit)
      </div>
    )
  }

  return (
    <ExpandSection
      summary={`${image.alt} · ${image.data.length.toLocaleString()} encoded characters`}
    >
      <LazyMcpImage image={image} />
    </ExpandSection>
  )
}

function ResourceLink({ block }: { block: UnknownRecord }) {
  const resource = isRecord(block.resource) ? block.resource : block
  const uri =
    typeof resource.uri === 'string'
      ? resource.uri
      : typeof resource.url === 'string'
        ? resource.url
        : null
  const name =
    typeof resource.name === 'string'
      ? resource.name
      : typeof block.name === 'string'
        ? block.name
        : uri
  const description =
    typeof resource.description === 'string'
      ? resource.description
      : typeof block.description === 'string'
        ? block.description
        : null

  return (
    <div className="rounded border border-border px-2 py-1.5 text-[12px] leading-[1.45]">
      {uri && isHttpUrl(uri) ? (
        <SafeMarkdownLink href={uri} className="text-accent underline break-all">
          {name ?? uri}
        </SafeMarkdownLink>
      ) : uri ? (
        <span title={uri} className="font-code text-ink-dim break-all">
          {isAbsolutePathLike(uri) ? formatToolFilePath(uri, null) : name ?? uri}
        </span>
      ) : (
        <span className="text-ink-dim">{name ?? 'Resource'}</span>
      )}
      {description ? <div className="mt-0.5 text-muted">{description}</div> : null}
    </div>
  )
}

function EmbeddedResource({
  block,
  isError,
}: {
  block: UnknownRecord
  isError: boolean
}) {
  const resource = isRecord(block.resource) ? block.resource : block
  const text = typeof resource.text === 'string' ? resource.text : null
  const blob = typeof resource.blob === 'string' ? resource.blob : null

  return (
    <div className="space-y-1.5">
      <ResourceLink block={block} />
      {text !== null ? <InlineText text={text} isError={isError} /> : null}
      {blob !== null ? (
        // Base64 is transport, not readable output. Showing its byte-ish size
        // acknowledges the payload without dumping thousands of opaque chars.
        <div className="text-[11px] text-muted">Binary resource · {blob.length} encoded characters</div>
      ) : null}
    </div>
  )
}

function InlineText({ text, isError }: { text: string; isError: boolean }) {
  const truncated = text.length > TEXT_MAX_CHARS
  const capped = truncated
    ? `${text.slice(0, TEXT_MAX_CHARS)}\n… output truncated`
    : text
  return (
    <div className="space-y-1">
      <pre
        className={`font-code text-[12px] leading-[1.55] whitespace-pre-wrap break-words m-0 max-h-[360px] overflow-auto ${isError ? 'text-danger' : 'text-ink-dim'}`}
      >
        <AnsiText text={capped} />
      </pre>
      {truncated ? (
        <ExpandSection summary="Exact text source (copyable)">
          <CodeBlock code={text} language="plaintext" highlight={false} />
        </ExpandSection>
      ) : null}
    </div>
  )
}

function hasMcpContentShape(value: unknown): value is UnknownRecord[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(item => isRecord(item) && typeof item.type === 'string')
  )
}

function ContentValue({
  value,
  isError,
  codeId,
  depth = 0,
}: {
  value: unknown
  isError: boolean
  codeId?: string
  depth?: number
}) {
  // Provider output is not trusted to be acyclic. We only interpret a couple
  // of envelope layers; beyond that, collapsed JSON is clearer and prevents a
  // malicious or malformed result from recursively constructing the DOM.
  if (depth > 3) {
    return <JsonDisclosure value={value} codeId={codeId} />
  }

  if (typeof value === 'string') {
    const parsed = tryExtractJson(value)
    if (parsed !== null && parsed !== value) {
      return (
        <div className="space-y-1.5">
          <ContentValue
            value={parsed}
            isError={isError}
            codeId={codeId}
            depth={depth + 1}
          />
          <ExactJsonSourceDisclosure source={value} codeId={codeId} />
        </div>
      )
    }
    return <InlineText text={value} isError={isError} />
  }

  if (hasMcpContentShape(value)) {
    return (
      <div className="space-y-2">
        {value.map((block, index) => {
          const type = String(block.type)
          if (type === 'text') {
            const text = textFromBlock(block)
            return text !== null ? (
              <ContentValue
                key={`text:${index}`}
                value={text}
                isError={isError}
                codeId={codeId ? `${codeId}:text:${index}` : undefined}
                depth={depth + 1}
              />
            ) : null
          }
          if (type === 'image') {
            return <McpImage key={`image:${index}`} block={block} />
          }
          if (type === 'resource' || type === 'embedded_resource') {
            return (
              <EmbeddedResource
                key={`${type}:${index}`}
                block={block}
                isError={isError}
              />
            )
          }
          if (type === 'resource_link') {
            return <ResourceLink key={`${type}:${index}`} block={block} />
          }
          // MCP is extensible. Unknown content types must remain visible, but
          // inventing a renderer for an unrecognized schema would be worse than
          // a transparent, collapsed source object.
          return (
            <JsonDisclosure
              key={`${type}:${index}`}
              value={block}
              codeId={codeId ? `${codeId}:${type}:${index}` : undefined}
              summary={`${type} content`}
            />
          )
        })}
      </div>
    )
  }

  if (isRecord(value)) {
    const content = value.content
    if (hasMcpContentShape(content)) {
      const structured = value.structuredContent ?? value.structured_content
      return (
        <div className="space-y-2">
          <ContentValue
            value={content}
            isError={isError || value.isError === true || value.is_error === true}
            codeId={codeId}
            depth={depth + 1}
          />
          {structured !== undefined ? (
            <RecordOrArray value={structured} isError={isError} codeId={codeId ? `${codeId}:structured` : undefined} />
          ) : null}
        </div>
      )
    }
    return <RecordPreview value={value} isError={isError} codeId={codeId} />
  }

  if (Array.isArray(value)) {
    return <ArrayPreview value={value} codeId={codeId} />
  }

  return <StructuredScalar value={value} />
}

function RecordOrArray({
  value,
  isError,
  codeId,
}: {
  value: unknown
  isError: boolean
  codeId?: string
}) {
  if (isRecord(value)) return <RecordPreview value={value} isError={isError} codeId={codeId} />
  if (Array.isArray(value)) return <ArrayPreview value={value} codeId={codeId} />
  return <StructuredScalar value={value} />
}

export type StructuredOutputProps = {
  value: unknown
  isError?: boolean
  /** A stable operation id keeps lazily-created code models separate when two
   *  adjacent operations happen to return identical JSON. */
  codeId?: string
}

export const StructuredOutput = memo(function StructuredOutput({
  value,
  isError = false,
  codeId,
}: StructuredOutputProps) {
  if (typeof value === 'string' && tryExtractJson(value) === null) {
    return <OutputWell text={value} isError={isError} ansi />
  }

  return (
    <MarkerRow marker="⎿" tone="muted">
      <ContentValue value={value} isError={isError} codeId={codeId} />
    </MarkerRow>
  )
})
