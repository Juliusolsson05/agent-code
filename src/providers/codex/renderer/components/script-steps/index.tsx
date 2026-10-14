import { useState, type ReactNode } from 'react'

import { PagedTextViewer } from '@renderer/lib/text/PagedTextViewer'

import type { ScriptResult, ScriptStep, ScriptStepsModel } from '@providers/codex/renderer/adapters/scriptSteps'

// A finished Codex `exec` script as the steps it ran (#1510; adapter:
// adapters/scriptSteps.ts says what it admits and why).
//
// The design was judged in the browser preview against 62 real scripts from
// the owner's rollouts, current vs proposed (2026-10-14), after the owner's
// "is this user friendly? what even is this" on the old fallback. Rules it
// follows:
//   - one line per step: what ran, then its verdict at the right edge
//     (✓ / ✕ exit N / ✕ error / ◌ still running · session N); a verdict is
//     shown only when the result carries one, never invented;
//   - output under its step, four lines or 480 characters, then "Show all";
//   - unknown structure is a CLOSED one-line summary, never an open dump;
//   - the transport boilerplate becomes a quiet duration; a failed script
//     says so, and its error is the script's, not the last step's;
//   - every recorded byte stays one click away ("View exact output").

const GLYPH: Record<ScriptStep['kind'], string> = { command: '$', mcp: '◆', stdin: '⌨', image: '▣', web: '◎', patch: '±', other: '•' }
const PREVIEW_LINES = 4
// Lines alone are not enough: minified JSON or one long log line wraps into
// a wall. Fold by characters too.
const PREVIEW_CHARS = 480

export function ScriptOutput({ text, tone = 'text-ink-dim' }: { text: string; tone?: string }) {
  const [open, setOpen] = useState(false)
  const lines = text.replace(/\s+$/, '').split('\n')
  if (lines.length === 1 && lines[0] === '') return <div className="pl-5 text-[11px] italic text-muted">no output</div>
  const head = lines.slice(0, PREVIEW_LINES).join('\n')
  const long = lines.length > PREVIEW_LINES || head.length > PREVIEW_CHARS
  const shown = open || !long ? text.replace(/\s+$/, '') : head.length > PREVIEW_CHARS ? `${head.slice(0, PREVIEW_CHARS)}…` : head
  return (
    <div className="ml-5 border-l border-border pl-2">
      <pre className={`max-h-72 overflow-auto whitespace-pre-wrap break-words font-code text-[11.5px] leading-[1.5] ${tone}`}>{shown}</pre>
      {long && (
        <button type="button" aria-expanded={open} className="font-code text-[11px] text-muted hover:text-ink" onClick={() => setOpen((value) => !value)}>
          {open ? 'Show less' : lines.length > 1 ? `Show all ${lines.length} lines` : 'Show all'}
        </button>
      )}
    </div>
  )
}

function DataSummary({ value }: { value: unknown }) {
  const [open, setOpen] = useState(false)
  const keys = value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value as object) : null
  const label = Array.isArray(value)
    ? `${value.length} item${value.length === 1 ? '' : 's'}`
    : keys
      ? `${keys.slice(0, 4).join(', ')}${keys.length > 4 ? ` +${keys.length - 4} more` : ''}`
      : String(value)
  return (
    <div className="ml-5">
      <button type="button" aria-expanded={open} className="font-code text-[11.5px] text-muted hover:text-ink" onClick={() => setOpen((v) => !v)}>
        {open ? '▾' : '▸'} data · {label}
      </button>
      {open && <ScriptOutput text={JSON.stringify(value, null, 2)} />}
    </div>
  )
}

/** One short verdict per result, only from what the result itself says. */
function verdict(result: ScriptResult | undefined): { text: string; tone: string } | null {
  if (!result) return null
  if (result.kind === 'command') {
    if (result.exitCode !== null) return result.exitCode === 0 ? { text: '✓', tone: 'text-ink-dim' } : { text: `✕ exit ${result.exitCode}`, tone: 'text-danger' }
    if (result.sessionId !== null) return { text: `◌ still running · session ${result.sessionId}`, tone: 'text-accent' }
    return null
  }
  if (result.kind === 'mcp') return result.isError ? { text: '✕ error', tone: 'text-danger' } : { text: '✓', tone: 'text-ink-dim' }
  if (result.kind === 'rejected') return { text: '✕ failed', tone: 'text-danger' }
  return null
}

/** MCP replies are mostly `{"ok":true,…}` acknowledgements: the ✓ says it. A refusal is a sentence in JSON: show the sentence. */
function mcpText(text: string): string | null {
  try {
    const value = JSON.parse(text) as Record<string, unknown>
    if (value && typeof value === 'object' && value.ok === true) return null
    for (const key of ['message', 'error', 'text']) if (typeof value?.[key] === 'string') return value[key] as string
    return JSON.stringify(value, null, 2)
  } catch {
    return text
  }
}

function ResultBody({ result }: { result: ScriptResult }): ReactNode {
  switch (result.kind) {
    case 'command':
      // A background session that printed nothing yet: the verdict says it
      // is still running; "no output" would read as "finished silently".
      if (result.sessionId !== null && result.exitCode === null && !result.output.trim()) return null
      return (
        <>
          <ScriptOutput text={result.output} tone={result.exitCode ? 'text-danger' : 'text-ink-dim'} />
          {result.truncatedTokens !== null && <div className="pl-5 text-[11px] text-muted">output cut to the agent's limit ({result.truncatedTokens.toLocaleString()} tokens)</div>}
        </>
      )
    case 'mcp': {
      const text = mcpText(result.text)
      return text === null ? null : <ScriptOutput text={text} tone={result.isError ? 'text-danger' : 'text-ink-dim'} />
    }
    case 'rejected':
    case 'script-error':
      return <ScriptOutput text={result.text} tone="text-danger" />
    case 'text':
      return <ScriptOutput text={result.text} />
    case 'tools':
      return <div className="pl-5 font-code text-[11.5px] text-muted">looked up {result.names.length} tool{result.names.length === 1 ? '' : 's'}: {result.names.join(', ')}</div>
    case 'json':
      return <DataSummary value={result.value} />
    case 'empty':
      return null
    case 'image':
      return <div className="pl-5 text-[11px] italic text-muted">image attached</div>
  }
}

function StepLine({ step, result }: { step: ScriptStep; result?: ScriptResult }) {
  const badge = verdict(result)
  return (
    <div className="flex flex-col gap-0.5" data-script-step={step.kind}>
      <div className="flex min-w-0 items-baseline gap-2 text-[12.5px]">
        <span aria-hidden className="w-3 shrink-0 text-center font-code text-muted">{GLYPH[step.kind]}</span>
        {step.kind !== 'command' && <span className="shrink-0 font-code text-ink">{step.title}</span>}
        <span className={`min-w-0 truncate font-code ${step.kind === 'command' ? 'text-ink' : 'text-muted'}`} title={step.detail}>{step.detail}</span>
        {badge && <span className={`ml-auto shrink-0 font-code text-[11px] ${badge.tone}`}>{badge.text}</span>}
      </div>
      {result && <ResultBody result={result} />}
    </div>
  )
}

export function CodexScriptStepsRow({ model }: { model: ScriptStepsModel }) {
  const [exactOpen, setExactOpen] = useState(false)
  const failed = model.status === 'failed' || model.status === 'terminated'
  const time = model.wallSeconds === null ? null : model.wallSeconds < 1 ? '<1 s' : `${model.wallSeconds.toFixed(1)} s`
  const single = model.steps.length === 1 && model.paired
  return (
    <div className="flex gap-2 py-1" data-codex-script-steps={model.status}>
      <span aria-hidden className={`mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full ${failed ? 'bg-danger' : 'bg-ink-dim'}`} />
      <div className="flex min-w-0 flex-1 flex-col gap-1.5 overflow-hidden">
        {/* One step: the step IS the headline. Several: a quiet count line. */}
        {(!single || failed) && (
          <div className="flex items-baseline gap-2 text-[12px] text-muted">
            <span className="text-ink-dim">{model.steps.length === 0 ? 'Ran a script' : `Ran ${model.steps.length} step${model.steps.length === 1 ? '' : 's'}`}</span>
            {failed && <span className="text-danger">script {model.status}</span>}
            {time && <span className="ml-auto font-code text-[11px]">{time}</span>}
          </div>
        )}
        {model.paired
          ? model.steps.map((step, index) => <StepLine key={index} step={step} result={model.results[index]} />)
          : (
            <>
              {model.steps.map((step, index) => <StepLine key={index} step={step} />)}
              {model.results.map((result, index) => <ResultBody key={`r${index}`} result={result} />)}
            </>
          )}
        {model.truncatedTokens !== null && (
          <div className="pl-5 text-[11px] text-muted">⚠ Codex cut this output short ({model.truncatedTokens.toLocaleString()} tokens); the agent saw the same cut.</div>
        )}
        <details className="ml-5 text-[11px] text-muted" onToggle={(event) => setExactOpen(event.currentTarget.open)}>
          <summary className="cursor-pointer hover:text-ink">view exact output · {model.exactOutput.length.toLocaleString()} characters</summary>
          {exactOpen ? <div className="mt-1"><PagedTextViewer source={model.exactOutput} /></div> : null}
        </details>
      </div>
    </div>
  )
}
