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

// No glyph here may carry the Unicode Emoji property (⌨ did): the phone
// renders these rows, and iOS draws an emoji-property symbol its faces lack
// as Apple Color Emoji (#1194, phoneSymbolFont.test.ts). `›` reads as "typed
// into" without needing a font subset entry.
const GLYPH: Record<ScriptStep['kind'], string> = { command: '$', mcp: '◆', stdin: '›', image: '▣', web: '◎', patch: '±', other: '•' }
const PREVIEW_LINES = 4
// Lines alone are not enough: minified JSON or one long log line wraps into
// a wall. Fold by characters too.
const PREVIEW_CHARS = 480
const RESULTS_SHOWN = 50

// Past this, "Show all" opens the bounded pager instead of one giant <pre>
// (review B2: a 1.5 MB build log became a single text node).
const INLINE_MAX_CHARS = 16 * 1024

export function ScriptOutput({ text, tone = 'text-ink-dim' }: { text: string; tone?: string }) {
  const [open, setOpen] = useState(false)
  // trimEnd, never /\s+$/: that regex backtracks quadratically over any long
  // whitespace run (measured 7 s at 50k blank characters, review B1).
  const trimmed = text.trimEnd()
  if (!trimmed) return <div className="pl-5 text-[11px] italic text-muted">no output</div>
  const lines = trimmed.split('\n')
  const head = lines.slice(0, PREVIEW_LINES).join('\n')
  const long = lines.length > PREVIEW_LINES || head.length > PREVIEW_CHARS
  const preview = head.length > PREVIEW_CHARS ? `${head.slice(0, PREVIEW_CHARS)}…` : head
  return (
    <div className="ml-5 border-l border-border pl-2">
      {open && trimmed.length > INLINE_MAX_CHARS
        ? <PagedTextViewer source={trimmed} />
        : <pre className={`max-h-72 overflow-auto whitespace-pre-wrap break-words font-code text-[11.5px] leading-[1.5] ${tone}`}>{open || !long ? trimmed : preview}</pre>}
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

/** One short verdict per result, only from what the result itself says. `label` is what a screen reader says. */
function verdict(result: ScriptResult | undefined): { text: string; tone: string; label: string } | null {
  if (!result) return null
  if (result.kind === 'command') {
    if (result.exitCode !== null) return result.exitCode === 0 ? { text: '✓', tone: 'text-ink-dim', label: 'succeeded' } : { text: `✕ exit ${result.exitCode}`, tone: 'text-danger', label: `failed with exit code ${result.exitCode}` }
    // A fact about the moment the result was taken, not a live claim: in a
    // reloaded conversation the session ended long ago (review A10).
    if (result.sessionId !== null) return { text: `◌ left running · session ${result.sessionId}`, tone: 'text-accent', label: `left running in session ${result.sessionId}` }
    return null
  }
  if (result.kind === 'mcp') {
    if (result.isError || mcpRefused(result.text)) return { text: '✕ error', tone: 'text-danger', label: 'failed' }
    return { text: '✓', tone: 'text-ink-dim', label: 'succeeded' }
  }
  if (result.kind === 'rejected') return { text: '✕ failed', tone: 'text-danger', label: 'failed' }
  return null
}

/** An MCP reply `{"ok":false,…}` without isError is still a refusal (review A9). */
function mcpRefused(text: string): boolean {
  try {
    const value = JSON.parse(text) as { ok?: unknown }
    return Boolean(value && typeof value === 'object' && value.ok === false)
  } catch {
    return false
  }
}

function Verdict({ result }: { result: ScriptResult | undefined }) {
  const badge = verdict(result)
  return badge ? <span className={`ml-auto shrink-0 font-code text-[11px] ${badge.tone}`} aria-label={badge.label}>{badge.text}</span> : null
}

/**
 * What an MCP reply shows: nothing for an `{"ok":true,…}` acknowledgement
 * (the ✓ says it), the sentence of a refusal, the text of plain content, and
 * any other JSON CLOSED (review B5: it used to open as a pretty dump).
 */
function mcpBody(text: string): { kind: 'none' } | { kind: 'text'; text: string } | { kind: 'json'; value: unknown } {
  try {
    const value = JSON.parse(text) as Record<string, unknown>
    if (value && typeof value === 'object' && value.ok === true) return { kind: 'none' }
    for (const key of ['message', 'error', 'text']) if (typeof value?.[key] === 'string') return { kind: 'text', text: value[key] as string }
    return { kind: 'json', value }
  } catch {
    return { kind: 'text', text }
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
      const body = mcpBody(result.text)
      if (body.kind === 'none') return null
      if (body.kind === 'json') return <DataSummary value={body.value} />
      return <ScriptOutput text={body.text} tone={result.isError || mcpRefused(result.text) ? 'text-danger' : 'text-ink-dim'} />
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
  }
}

function StepLine({ step, result, time }: { step: ScriptStep; result?: ScriptResult; time?: string | null }) {
  return (
    <div className="flex flex-col gap-0.5" data-script-step={step.kind}>
      <div className="flex min-w-0 items-baseline gap-2 text-[12.5px]">
        <span aria-hidden className="w-3 shrink-0 text-center font-code text-muted">{GLYPH[step.kind]}</span>
        {step.kind !== 'command' && <span className="shrink-0 font-code text-ink">{step.title}</span>}
        <span className={`min-w-0 truncate font-code ${step.kind === 'command' ? 'text-ink' : 'text-muted'}`} title={step.detail}>{step.detail}</span>
        <Verdict result={result} />
        {time && <span className="shrink-0 font-code text-[11px] text-muted">{time}</span>}
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
          ? model.steps.map((step, index) => <StepLine key={index} step={step} result={model.results[index]} time={single ? time : null} />)
          : (
            <>
              {model.steps.map((step, index) => <StepLine key={index} step={step} />)}
              {/* Not attributable to a step: each result still carries its own
                  verdict (review B4: exit codes vanished here), capped so a
                  pathological script cannot mount thousands of rows. */}
              {model.results.slice(0, RESULTS_SHOWN).map((result, index) => (
                <div key={`r${index}`} className="flex flex-col gap-0.5" data-script-result={result.kind}>
                  {verdict(result) && <div className="flex pl-5 text-[11px]"><Verdict result={result} /></div>}
                  <ResultBody result={result} />
                </div>
              ))}
              {model.results.length > RESULTS_SHOWN && (
                <div className="pl-5 text-[11px] text-muted">{(model.results.length - RESULTS_SHOWN).toLocaleString()} more results · view exact output</div>
              )}
            </>
          )}
        {model.truncatedTokens !== null && (
          <div className="pl-5 text-[11px] text-muted">Codex cut this output short ({model.truncatedTokens.toLocaleString()} tokens); the agent saw the same cut.</div>
        )}
        <details className="ml-5 text-[11px] text-muted" onToggle={(event) => setExactOpen(event.currentTarget.open)}>
          <summary className="cursor-pointer hover:text-ink">view exact output · {model.exactOutput.length.toLocaleString()} characters</summary>
          {exactOpen ? <div className="mt-1"><PagedTextViewer source={model.exactOutput} /></div> : null}
        </details>
      </div>
    </div>
  )
}
