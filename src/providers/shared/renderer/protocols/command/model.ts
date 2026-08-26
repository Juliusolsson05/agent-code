// CommandRenderModel — the second shared visual protocol (renderer rewrite
// PR #555, Phase 6). Same rules as code-edit: provider adapters map their
// own wire shapes one-way into this model; the shared CommandView consumes
// ONLY this. No provider field, no raw escape hatch, no parsing in the
// view. Import-boundary tests police it.
//
// STREAMING-FIRST: a model must be paintable the moment the COMMAND STRING
// is known (the earliest honest headline) — output/exit arrive as props
// updates to the same row, never as a different card.

export type CommandStatus =
  | 'streaming' // input still arriving
  | 'running'
  | 'success'
  | 'failure'
  | 'timeout'
  /** Terminal result arrived, but the provider transport carried no exit
   *  evidence (e.g. Codex code-mode `text(r.output)`, where "Script
   *  completed" only proves the wrapper JavaScript ran). Adapters MUST use
   *  this instead of `success` whenever they cannot prove exit 0 — the view
   *  renders a muted "exit code unavailable" so the feed distinguishes
   *  missing transport evidence from an unknown/running process outcome. */
  | 'unknown'

export type CommandRenderModel = {
  /** Provider-chosen label vocabulary (Bash, exec, local_shell…). The view
   *  prints it, never branches on it. */
  label: string
  /** The command line(s), already bounded by the adapter for the headline
   *  (the transcript keeps the exact full source). */
  command: string
  /** Working directory ONLY when it differs from the workspace root —
   *  adapters decide; the view just shows what it's given. */
  cwd?: string
  status: CommandStatus
  /** Exit code when known; null while running/streaming or when the
   *  provider never reports one. */
  exitCode: number | null
  /** Raw (possibly ANSI) output — the view routes it through OutputWell,
   *  which owns head/tail preview, caps, and ANSI painting. Empty string
   *  = genuinely no output (renders a quiet "(no output)"), undefined =
   *  output not arrived/not applicable (renders nothing). */
  output?: string
  outputIsError?: boolean
  /** One bounded line, visible without expansion, for failures. */
  errorSummary?: string
  /** Formatter enrichment (Phase 6 formatters): a short trusted conclusion
   *  line (e.g. "12 passed, 1 failed") rendered ABOVE the output — it
   *  enriches, never replaces, the bounded raw evidence. */
  conclusion?: string
}
