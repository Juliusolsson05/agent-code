import { memo, useContext, useMemo } from 'react'

import { formatToolFilePath } from '@shared/paths/displayPath'

import { CodeRenderContext } from '@renderer/features/feed/context'
import { MarkerRow } from '@renderer/features/feed/ui/MarkerRow'
import { StructuredOutput } from '@renderer/features/feed/ui/kit/StructuredOutput'
import { SafeMarkdownLink } from '@renderer/features/rendered-content/SafeMarkdownLink'

import { analyzeCommandOutput, type CommandTestSummary } from './CommandOutputAnalysis'

function TestSummary({ summary }: { summary: CommandTestSummary }) {
  const counts = [
    summary.passed === null
      ? null
      : { label: `${summary.passed} passed`, className: 'text-success' },
    summary.failed === null
      ? null
      : { label: `${summary.failed} failed`, className: summary.failed > 0 ? 'text-danger' : 'text-muted' },
    summary.skipped === null
      ? null
      : { label: `${summary.skipped} skipped`, className: 'text-muted' },
  ].filter((item): item is { label: string; className: string } => item !== null)

  return (
    <MarkerRow marker={summary.failed !== null && summary.failed > 0 ? '✗' : '✓'} tone="muted">
      <div className="flex flex-wrap items-baseline gap-x-2 text-[12px] leading-[1.55]">
        <span className="text-ink-dim font-semibold">Tests</span>
        {counts.map(({ label, className }) => (
          <span key={label} className={className}>{label}</span>
        ))}
      </div>
    </MarkerRow>
  )
}

/** User-helpful interpretations which sit *above*, never instead of, raw
 * terminal output. The command card remains the owner of OutputWell so ANSI,
 * live deltas, clipping, and expand/collapse have one lossless path. */
export const CommandOutput = memo(function CommandOutput({
  text,
  isError,
  codeId,
}: {
  text: string
  isError: boolean
  codeId: string
}) {
  const { workspaceRoot } = useContext(CodeRenderContext)
  const analysis = useMemo(() => analyzeCommandOutput(text), [text])
  const hasEnrichment =
    analysis.structuredJson !== null ||
    analysis.testSummary !== null ||
    analysis.diagnostics.length > 0 ||
    analysis.urls.length > 0

  if (!hasEnrichment) return null

  return (
    <div className="mt-1 space-y-1.5" data-command-output-enrichment>
      {analysis.structuredJson !== null ? (
        // StructuredOutput owns the compact field/list preview and lazy full
        // JSON disclosure. The original bytes still render immediately below
        // in OutputWell; parsing can only add a view, never consume evidence.
        <StructuredOutput value={analysis.structuredJson} isError={isError} codeId={`${codeId}:json`} />
      ) : null}

      {analysis.testSummary ? <TestSummary summary={analysis.testSummary} /> : null}

      {analysis.diagnostics.length > 0 ? (
        <MarkerRow marker="↳" tone="muted">
          <div className="space-y-1 text-[12px] leading-[1.5]">
            <div className="text-ink-dim font-semibold">
              {analysis.diagnostics.length === 1 ? 'Diagnostic' : 'Diagnostics'}
            </div>
            {analysis.diagnostics.map(diagnostic => {
              const displayPath = formatToolFilePath(diagnostic.path, workspaceRoot)
              const location = `${displayPath}:${diagnostic.line}${diagnostic.column === null ? '' : `:${diagnostic.column}`}`
              const tone =
                diagnostic.severity === 'error'
                  ? 'text-danger'
                  : diagnostic.severity === 'warning'
                    ? 'text-warning'
                    : 'text-ink-dim'
              return (
                <div key={`${diagnostic.target}\0${diagnostic.message}`} className="min-w-0">
                  <SafeMarkdownLink
                    href={diagnostic.target}
                    className="font-code text-accent underline decoration-accent/40 underline-offset-2 break-all"
                    title="Open in Global Editor"
                  >
                    {location}
                  </SafeMarkdownLink>
                  <span className={`ml-2 whitespace-pre-wrap break-words ${tone}`}>
                    {diagnostic.message}
                  </span>
                </div>
              )
            })}
          </div>
        </MarkerRow>
      ) : null}

      {analysis.urls.length > 0 ? (
        <MarkerRow marker="↗" tone="muted">
          <div className="space-y-0.5 text-[12px] leading-[1.5]">
            <div className="text-ink-dim font-semibold">
              {analysis.urls.length === 1 ? 'Link' : 'Links'}
            </div>
            {analysis.urls.map(url => (
              <div key={url} className="min-w-0">
                <SafeMarkdownLink
                  href={url}
                  className="text-accent underline decoration-accent/40 underline-offset-2 break-all"
                >
                  {url}
                </SafeMarkdownLink>
              </div>
            ))}
          </div>
        </MarkerRow>
      ) : null}
    </div>
  )
})
