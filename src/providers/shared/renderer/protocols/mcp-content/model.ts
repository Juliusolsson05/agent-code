import { asRecord } from '@shared/lib/asRecord'

const MAX_PARSE_CHARS = 1024 * 1024
const MAX_VISIBLE_BLOCKS = 80

export type McpContentBlock = {
  type: string
  value: Record<string, unknown>
}

export type McpContentModel = {
  blocks: readonly McpContentBlock[]
  totalBlocks: number
  isError: boolean
  structuredContent: unknown
  metadata: Record<string, unknown> | null
  raw: unknown
}

const KNOWN_CONTENT_TYPES = new Set([
  'text',
  'image',
  'audio',
  'resource',
  'resource_link',
])

function parseString(value: string): unknown | null {
  if (value.length === 0 || value.length > MAX_PARSE_CHARS) return null
  const trimmed = value.trim()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null
  try {
    return JSON.parse(trimmed)
  } catch {
    return null
  }
}

export function isMcpContentCarrier(value: unknown): boolean {
  const record = asRecord(value)
  if (!record || !Array.isArray(record.content)) return false
  return record.content.some(item => {
    const block = asRecord(item)
    return typeof block?.type === 'string' && KNOWN_CONTENT_TYPES.has(block.type)
  })
}

/**
 * Parse MCP's open typed-content carrier without claiming each server's domain
 * payload. This is protocol rendering only: text/image/audio/resource blocks
 * get standard treatment, while unfamiliar block types remain exact JSON.
 */
export function parseMcpContentResult(
  raw: unknown,
  options: { allowDirectArray?: boolean } = {},
): McpContentModel | null {
  const parsed = typeof raw === 'string' ? parseString(raw) : raw
  const record = asRecord(parsed)
  const content = Array.isArray(parsed)
    ? options.allowDirectArray === true ? parsed : null
    : Array.isArray(record?.content) ? record.content : null
  if (!content || content.length === 0) return null

  const blocks: McpContentBlock[] = []
  let hasKnownType = false
  const inspectLimit = Math.min(content.length, MAX_VISIBLE_BLOCKS)
  for (let index = 0; index < inspectLimit; index += 1) {
    const item = asRecord(content[index])
    if (!item || typeof item.type !== 'string' || !/\S/.test(item.type)) return null
    if (KNOWN_CONTENT_TYPES.has(item.type)) hasKnownType = true
    blocks.push({ type: item.type, value: item })
  }
  if (!hasKnownType) return null

  return {
    blocks,
    totalBlocks: content.length,
    isError: record?.isError === true,
    structuredContent: record?.structuredContent,
    metadata: asRecord(record?._meta),
    raw: parsed,
  }
}

export function mcpContentCounts(model: McpContentModel): string {
  const counts = new Map<string, number>()
  for (const block of model.blocks) {
    counts.set(block.type, (counts.get(block.type) ?? 0) + 1)
  }
  const labels = [...counts.entries()].map(([type, count]) => `${count} ${type.replace(/_/g, ' ')}`)
  if (model.blocks.length < model.totalBlocks) {
    labels.push(`${model.totalBlocks - model.blocks.length} more`)
  }
  return labels.join(' · ')
}
