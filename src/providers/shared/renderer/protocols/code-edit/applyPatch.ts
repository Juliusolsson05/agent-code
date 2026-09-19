import type { ToolResultBlock } from '@shared/types/transcript'
import { boundedTextPage } from '@renderer/lib/text/boundedText'
import type { DiffLine } from '@shared/parsers/lineDiff'
import type {
  CodeEditFile,
  CodeEditRenderModel,
} from '@providers/shared/renderer/protocols/code-edit/model'

export type ApplyPatchFile = {
  path: string
  action: 'Add' | 'Update' | 'Delete'
  movedTo?: string
  lines: DiffLine[]
}

type ApplyPatchPreview = {
  files: ApplyPatchFile[]
  totalFiles: number
  fileCountTruncated: boolean
  patchClosed: boolean
  previewTruncated: boolean
}

const VERB = { Add: 'Creating', Update: 'Editing', Delete: 'Deleting' } as const

export function rawDirectApplyPatchText(input: unknown): string {
  if (typeof input === 'string') return input
  if (!input || typeof input !== 'object' || Array.isArray(input)) return ''
  const record = input as Record<string, unknown>
  return typeof record.patchText === 'string' ? record.patchText : ''
}

export function codeEditModelFromDirectApplyPatchText(
  rawPatch: string,
  opts: { streaming?: boolean; result?: ToolResultBlock | null } = {},
): CodeEditRenderModel | null {
  const preview = parseApplyPatchPreviewFromText(rawPatch)
  const files = preview.files.map((file, index) => ({
    path: file.movedTo ? `${file.path} → ${file.movedTo}` : file.path,
    verb: file.movedTo ? 'Moving' : VERB[file.action],
    lines: file.lines,
    additions: file.lines.filter(line => line.kind === '+').length,
    deletions: file.lines.filter(line => line.kind === '-').length,
    previewTruncated: preview.previewTruncated && index === preview.files.length - 1,
    countsTruncated: preview.previewTruncated && index === preview.files.length - 1,
    streaming: opts.streaming === true,
  }) satisfies CodeEditFile)
  if (files.length === 0) return null

  const failed = opts.result?.is_error === true
  return {
    label: 'apply_patch',
    files,
    totalFiles: preview.totalFiles,
    fileCountTruncated: preview.fileCountTruncated,
    status: failed
      ? 'failure'
      : opts.result
        ? 'success'
        : opts.streaming
          ? 'streaming'
          : 'running',
    errorSummary: failed ? firstLine(opts.result) : undefined,
    partial: opts.streaming === true || preview.previewTruncated || !preview.patchClosed,
  }
}

function parseApplyPatchPreviewFromText(fullText: string): ApplyPatchPreview {
  if (!fullText.includes('*** Begin Patch')) {
    return {
      files: [],
      totalFiles: 0,
      fileCountTruncated: false,
      patchClosed: false,
      previewTruncated: false,
    }
  }

  const page = boundedTextPage(fullText)
  const text = page.text
  const endMatch = /^\*\*\* End Patch\r?$/m.exec(text)
  const files: ApplyPatchFile[] = []
  let current: ApplyPatchFile | null = null

  for (const rawLine of text.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    if (line === '*** End Patch') break

    const fileMatch = line.match(/^\*\*\* (Add|Update|Delete) File: (.+)$/)
    if (fileMatch) {
      current = {
        action: fileMatch[1] as ApplyPatchFile['action'],
        path: fileMatch[2] ?? '',
        lines: [],
      }
      files.push(current)
      continue
    }

    if (!current) continue

    const moveMatch = line.match(/^\*\*\* Move to: (.+)$/)
    if (moveMatch) {
      current.movedTo = moveMatch[1] ?? ''
      continue
    }

    if (line === '*** Begin Patch' || line === '*** End of File' || line.startsWith('@@')) continue
    if (line.startsWith('+')) current.lines.push({ kind: '+', text: line.slice(1) })
    else if (line.startsWith('-')) current.lines.push({ kind: '-', text: line.slice(1) })
    else if (line.startsWith(' ')) current.lines.push({ kind: 'ctx', text: line.slice(1) })
  }

  return {
    files,
    totalFiles: files.length,
    fileCountTruncated: page.hasNext && endMatch === null,
    patchClosed: endMatch !== null,
    previewTruncated: page.hasNext && endMatch === null,
  }
}

function firstLine(result: ToolResultBlock | null | undefined): string | undefined {
  const content = result?.content
  const text = typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? String((content[0] as { text?: unknown })?.text ?? '')
      : ''
  return text ? text.split('\n')[0].slice(0, 200) : 'patch failed'
}
