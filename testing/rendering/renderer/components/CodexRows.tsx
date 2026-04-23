import { memo, useContext } from 'react'

import { CodeBlock } from './CodeBlock'
import { CodeRenderContext, MarkerRow } from './Feed'
import type { ToolResultBlock, ToolUseBlock } from '@shared/types/transcript'

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null
}

function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map(item => {
        if (typeof item === 'string') return item
        const rec = asRecord(item)
        return typeof rec?.text === 'string' ? rec.text : JSON.stringify(item, null, 2)
      })
      .join('\n')
  }
  return String(content ?? '')
}

function summarizePatchTargets(input: unknown): string[] {
  const text =
    typeof input === 'string'
      ? input
      : typeof asRecord(input)?.raw === 'string'
        ? String(asRecord(input)?.raw)
        : ''
  if (!text) return []
  const matches = [...text.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)]
  return matches.map(match => match[1]).slice(0, 6)
}

function headlineForTool(block: ToolUseBlock): string | null {
  const input = asRecord(block.input)
  if (!input) return null

  if (block.name === 'exec_command') {
    const cmd = input.cmd
    if (typeof cmd === 'string') return cmd
    if (Array.isArray(cmd)) return cmd.join(' ')
  }

  if (block.name === 'apply_patch') {
    const targets = summarizePatchTargets(block.input)
    if (targets.length > 0) return targets.join('\n')
  }

  if (typeof input.command === 'string') return input.command
  if (typeof input.description === 'string') return input.description
  if (typeof input.path === 'string') return input.path
  if (typeof input.arguments === 'string') return input.arguments.slice(0, 160)
  if (typeof input.raw === 'string' && block.name !== 'apply_patch') return input.raw.slice(0, 160)
  return null
}

function detectDiff(text: string): boolean {
  return text.startsWith('diff --git ') || text.startsWith('@@ ')
}

function parsedCommand(meta: Record<string, unknown> | null): Record<string, unknown> | null {
  const parsed = meta?.parsedCmd
  if (!Array.isArray(parsed)) return null
  return asRecord(parsed[0])
}

function parsedPath(parsed: Record<string, unknown> | null): string | null {
  if (typeof parsed?.path === 'string') return parsed.path
  if (typeof parsed?.name === 'string') return parsed.name
  return null
}

export const CodexToolRow = memo(function CodexToolRow({
  block,
}: {
  block: ToolUseBlock
}) {
  const headline = headlineForTool(block)

  return (
    <MarkerRow marker="⏺">
      <div>
        <div className="text-[13px] leading-[1.65]">
          <span className="text-accent font-semibold">{block.name}</span>
        </div>
        {headline && (
          <MarkerRow marker="⎿" tone="muted">
            <pre className="font-code text-[12px] leading-[1.55] text-ink-dim whitespace-pre-wrap break-all m-0">
              {headline}
            </pre>
          </MarkerRow>
        )}
      </div>
    </MarkerRow>
  )
})

export const CodexToolResultRow = memo(function CodexToolResultRow({
  block,
}: {
  block: ToolResultBlock
}) {
  const codeContext = useContext(CodeRenderContext)
  const text = textFromContent(block.content).replace(/\s+$/, '')
  const meta = asRecord(asRecord(block)?.codex)
  const kind = typeof meta?.kind === 'string' ? meta.kind : null
  const isError = block.is_error === true

  if (kind === 'exec_command_end') {
    const parsed = parsedCommand(meta)
    const parsedType = typeof parsed?.type === 'string' ? parsed.type : null
    const path = parsedPath(parsed)

    if (!text && !isError) return null

    if (
      (parsedType === 'read' || parsedType === 'search') &&
      path &&
      text
    ) {
      return (
        <MarkerRow marker="⎿" tone="muted">
          <CodeBlock
            code={text}
            path={path}
            workspaceRoot={codeContext.workspaceRoot}
            codeId={`codex-${parsedType}:${block.tool_use_id}`}
            engine="monaco"
            allowAutoDetect
          />
        </MarkerRow>
      )
    }

    if (detectDiff(text)) {
      return (
        <MarkerRow marker="⎿" tone="muted">
          <CodeBlock
            code={text}
            language="diff"
            workspaceRoot={codeContext.workspaceRoot}
            codeId={`codex-diff:${block.tool_use_id}`}
          />
        </MarkerRow>
      )
    }
  }

  if (kind === 'patch_apply_end') {
    const changes = asRecord(meta?.changes)
    const items = changes ? Object.entries(changes) : []
    if (items.length > 0) {
      return (
        <MarkerRow marker="⎿" tone="muted">
          <div className="flex flex-col gap-2 w-full">
            {items.map(([filePath, change]) => {
              const rec = asRecord(change)
              const diff = typeof rec?.unified_diff === 'string' ? rec.unified_diff : ''
              return (
                <div key={filePath} className="flex flex-col gap-1">
                  <div className="text-[12px] text-ink-dim font-code break-all">
                    {filePath}
                  </div>
                  {diff ? (
                    <CodeBlock
                      code={diff}
                      language="diff"
                      workspaceRoot={codeContext.workspaceRoot}
                      codeId={`codex-patch:${block.tool_use_id}:${filePath}`}
                    />
                  ) : text ? (
                    <CodeBlock
                      code={text}
                      workspaceRoot={codeContext.workspaceRoot}
                      codeId={`codex-patch-fallback:${block.tool_use_id}:${filePath}`}
                      engine="monaco"
                      allowAutoDetect
                    />
                  ) : null}
                </div>
              )
            })}
          </div>
        </MarkerRow>
      )
    }
  }

  if (!text && !isError) return null

  // Route through CodeBlock for consistent rendering with Claude —
  // gives syntax highlighting, Monaco when available, and the same
  // visual treatment as Claude's tool result rows.
  if (!isError && text) {
    return (
      <MarkerRow marker="⎿" tone="muted">
        <CodeBlock
          code={text}
          workspaceRoot={codeContext.workspaceRoot}
          codeId={`codex-result:${block.tool_use_id}`}
          engine="monaco"
          allowAutoDetect
        />
      </MarkerRow>
    )
  }

  return (
    <MarkerRow marker="⎿" tone="muted">
      <pre
        className={`
          font-code text-[12px] leading-[1.55] whitespace-pre-wrap break-words m-0
          max-h-[360px] overflow-auto
          ${isError ? 'text-danger' : 'text-ink-dim'}
        `}
      >
        {text || '(no output)'}
      </pre>
    </MarkerRow>
  )
})
