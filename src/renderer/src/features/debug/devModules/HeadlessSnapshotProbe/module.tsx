import { useMemo, useState } from 'react'

import type { DevDebugModule, DevDebugModuleProps } from '@renderer/features/debug/devModules/types'

export const headlessSnapshotProbeModule: DevDebugModule = {
  id: 'headless-snapshot-probe',
  title: 'Headless Snapshot Probe',
  description: 'Inspect focused screen/markdown snapshots and test regexes against both.',
  Component: HeadlessSnapshotProbe,
}

function HeadlessSnapshotProbe({ sessionId, runtime, kind }: DevDebugModuleProps) {
  const [pattern, setPattern] = useState('\\[Pasted text #\\d+')
  const [flags, setFlags] = useState('i')
  const plain = runtime.screen
  const markdown = runtime.screenMarkdown

  const regex = useMemo(() => {
    try {
      return { ok: true as const, value: new RegExp(pattern, flags) }
    } catch (err) {
      return {
        ok: false as const,
        message: err instanceof Error ? err.message : String(err),
      }
    }
  }, [flags, pattern])

  const plainMatch = useMemo(
    () => regex.ok ? summarizeMatch(plain, regex.value) : null,
    [plain, regex],
  )
  const markdownMatch = useMemo(
    () => regex.ok ? summarizeMatch(markdown, regex.value) : null,
    [markdown, regex],
  )

  return (
    <div className="border border-border bg-[#101010]">
      <div className="border-b border-border px-3 py-2 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[10px] text-red-300 uppercase tracking-[0.12em]">
            headless snapshot probe
          </div>
          <div className="mt-0.5 text-[10px] text-muted truncate">
            {kind} · {sessionId}
          </div>
        </div>
        <div className="text-[10px] text-muted tabular-nums">
          {plain.length} plain / {markdown.length} md
        </div>
      </div>

      <div className="p-3 flex flex-col gap-3">
        <div className="grid grid-cols-[1fr_80px] gap-2">
          <label className="flex flex-col gap-1">
            <span className="text-[9px] text-muted uppercase tracking-[0.12em]">regex</span>
            <input
              value={pattern}
              onChange={event => setPattern(event.target.value)}
              className="bg-canvas border border-border px-2 py-1 text-[11px] text-ink outline-none focus:border-accent"
              spellCheck={false}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[9px] text-muted uppercase tracking-[0.12em]">flags</span>
            <input
              value={flags}
              onChange={event => setFlags(event.target.value)}
              className="bg-canvas border border-border px-2 py-1 text-[11px] text-ink outline-none focus:border-accent"
              spellCheck={false}
            />
          </label>
        </div>

        {!regex.ok && (
          <div className="border border-red-500/40 bg-red-950/20 px-2 py-1 text-[11px] text-red-300">
            {regex.message}
          </div>
        )}

        {regex.ok && (
          <div className="grid grid-cols-2 gap-2">
            <MatchCard title="plain" result={plainMatch} />
            <MatchCard title="markdown" result={markdownMatch} />
          </div>
        )}

        <Snapshot title="plain screen" value={plain || '(empty)'} />
        <Snapshot title="markdown screen" value={markdown || '(empty)'} />
      </div>
    </div>
  )
}

function summarizeMatch(value: string, regex: RegExp): { matched: boolean; index: number | null; text: string } {
  regex.lastIndex = 0
  const match = regex.exec(value)
  if (!match) return { matched: false, index: null, text: '' }
  return {
    matched: true,
    index: match.index,
    text: match[0],
  }
}

function MatchCard({
  title,
  result,
}: {
  title: string
  result: { matched: boolean; index: number | null; text: string } | null
}) {
  const matched = Boolean(result?.matched)
  return (
    <div className="border border-border bg-canvas px-2 py-1">
      <div className="flex items-center justify-between gap-2 text-[9px] uppercase tracking-[0.12em]">
        <span className="text-muted">{title}</span>
        <span className={matched ? 'text-green-400' : 'text-red-400'}>
          {matched ? 'match' : 'no match'}
        </span>
      </div>
      <div className="mt-1 text-[10px] text-ink-dim break-all">
        {matched ? `@${result?.index}: ${result?.text}` : '(none)'}
      </div>
    </div>
  )
}

function Snapshot({ title, value }: { title: string; value: string }) {
  return (
    <section>
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="text-[9px] text-muted uppercase tracking-[0.12em]">{title}</span>
        <button
          type="button"
          onClick={() => void navigator.clipboard.writeText(value)}
          className="border border-border/80 px-1.5 py-0.5 text-[10px] text-ink-dim hover:border-border-hi hover:text-ink"
        >
          copy
        </button>
      </div>
      <pre className="max-h-[220px] overflow-auto whitespace-pre-wrap break-words border border-[#222] bg-[#0b0b0b] px-2 py-1 text-[10px] leading-[1.45] text-ink-dim">
        {value}
      </pre>
    </section>
  )
}
