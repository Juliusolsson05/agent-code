import type { DiffLine } from '@shared/parsers/lineDiff'
import type { AgentProviderKind } from '@shared/types/providerKind'

// ArtifactVM — the normalized view-model every artifact card renders.
//
// WHY this layer exists (spec §3/§4,
// docs/superpowers/specs/2026-07-11-feed-render-layer-rewrite-design.md):
// the same logical artifact (a Bash run, an Edit, a web search) reaches
// React through TWO different shapes — committed ToolUseBlock/
// ToolResultBlock pairs and live SemanticLiveBlock — and historically
// each shape grew its own renderer. The two dispatch ladders (committed
// Block.tsx vs live BlockRow.tsx) drifted apart repeatedly: live MCP
// dumps looked nothing like their committed twins, Codex web_search had
// a bespoke live chip and an ugly generic committed row. Normalizing
// both planes into ONE VM per artifact family makes "live ≈ committed"
// true BY CONSTRUCTION: the same card renders status:'streaming' and
// status:'complete', and finishing a tool is a props flip, never a
// component swap.
//
// Rules for this file:
//   - Types only. No functions, no React. The resolvers live in
//     ui/resolve/, the cards in ui/artifacts/<family>.tsx.
//   - Every family payload carries data BOTH planes can populate;
//     fields a plane can't know yet are null, never fabricated. A
//     card must render sensibly with every nullable field null.
//   - `plane` is provenance for debug emission ONLY. A card that
//     branches on it is reintroducing the live/committed fork this
//     layer exists to kill.

export type ArtifactStatus =
  /** tool input still arriving (tool_input_delta / partial inputJson) */
  | 'streaming'
  /** input finalized, awaiting result */
  | 'running'
  /** result attached (or committed pair resolved) without error */
  | 'complete'
  /** is_error result / non-zero exit code / parse refusal */
  | 'error'

export type ArtifactBase = {
  /** Stable identity for React keys and memo caches. Derived from
   *  toolUseId/callId/entry uuid — NEVER the visible index (that
   *  produced the React-subtree-reuse phantom-duplicate class). */
  id: string
  provider: AgentProviderKind
  status: ArtifactStatus
  /** Provenance for debug emission only — cards MUST NOT branch on it. */
  plane: 'committed' | 'live'
  toolUseId: string | null
  startedAt: number | null
  endedAt: number | null
}

// ---------------------------------------------------------------------------
// Families
// ---------------------------------------------------------------------------

export type CommandArtifact = ArtifactBase & {
  family: 'command'
  command: string
  cwd: string | null
  description: string | null
  /** Which wire-level tool produced this — display metadata (the $ card
   *  is identical for all of them), kept for debugging provenance. */
  sourceTool: 'Bash' | 'exec_command' | 'local_shell_call' | 'bash' | 'write_stdin'
  /** Raw output, ANSI escapes preserved (OutputWell renders them). */
  output: string | null
  exitCode: number | null
  durationMs: number | null
  /** Codex exec metadata chips. */
  yieldTimeMs: number | null
  maxOutputTokens: number | null
  /** Codex write_stdin payloads attached to this command surface. */
  stdinWrites: string[]
  /** Codex classified this exec as a file read / search (parsed_cmd
   *  meta) — the card shows a "Read N lines from <path>" summary with
   *  expandable source instead of a raw OutputWell. */
  parsedRead: { kind: 'read' | 'search'; path: string | null } | null
}

export type FileEditArtifact = ArtifactBase & {
  family: 'file-edit'
  filePath: string | null
  /** One DiffLine[] per edit chunk (Claude Edit = 1, MultiEdit = N).
   *  Empty while the live input is still unparseable. */
  diffs: DiffLine[][]
  /** Codex apply_patch: per-file parsed patch. Mutually exclusive with
   *  `diffs` in practice (Claude fills diffs, Codex fills patchFiles);
   *  the card renders whichever is non-empty. */
  patchFiles: Array<{
    path: string
    action: 'add' | 'update' | 'delete'
    movedTo: string | null
    lines: DiffLine[]
  }>
  /** Raw streaming input to show until parseable (live plane only). */
  rawStreamingInput: string | null
  resultError: string | null
}

export type FileWriteArtifact = ArtifactBase & {
  family: 'file-write'
  filePath: string | null
  content: string
  lineCount: number
}

export type ReadArtifact = ArtifactBase & {
  family: 'file-read'
  kind: 'read' | 'grep' | 'glob' | 'ls'
  /** file path (read) or directory/scope path (grep/glob/ls) */
  target: string | null
  pattern: string | null
  resultText: string | null
  resultIsError: boolean
}

export type TodoArtifact = ArtifactBase & {
  family: 'todo'
  todos: Array<{
    content: string
    status: 'pending' | 'in_progress' | 'completed'
    activeForm: string
  }>
}

export type WebArtifact = ArtifactBase & {
  family: 'web'
  kind: 'search' | 'fetch' | 'open_page' | 'find_in_page'
  query: string | null
  queries: string[]
  url: string | null
  pattern: string | null
  resultText: string | null
}

export type AgentSpawnArtifact = ArtifactBase & {
  family: 'agent-spawn'
  /** The raw tool_use block — AgentCard delegates to the existing
   *  TaskSubagentRow machinery (SubAgentsContext keyed by tool_use id),
   *  which already renders live status/elapsed/mini-feed well. */
  toolName: string
  input: Record<string, unknown> | null
}

export type McpArtifact = ArtifactBase & {
  family: 'mcp'
  server: string
  tool: string
  params: Record<string, unknown> | null
  paramsJson: string
  resultText: string | null
  resultIsError: boolean
}

export type SlashCommandArtifact = ArtifactBase & {
  family: 'slash-command'
  name: string
  message: string | null
  args: string | null
  stdout: string | null
}

export type ImageGenArtifact = ArtifactBase & {
  family: 'image-gen'
  genStatus: string | null
  revisedPrompt: string | null
  result: string | null
}

export type GenericToolArtifact = ArtifactBase & {
  family: 'generic'
  toolName: string
  /** MCP-aware pretty name (mcp__srv__tool → "tool (srv)"). */
  prettyName: string
  mcp: { server: string; tool: string } | null
  headline: string | null
  params: Record<string, unknown> | null
  /** Raw (possibly partial mid-stream) input JSON. */
  paramsJson: string
  parseError: string | null
  resultText: string | null
  resultIsError: boolean
}

export type ArtifactVM =
  | CommandArtifact
  | FileEditArtifact
  | FileWriteArtifact
  | ReadArtifact
  | TodoArtifact
  | WebArtifact
  | AgentSpawnArtifact
  | McpArtifact
  | SlashCommandArtifact
  | ImageGenArtifact
  | GenericToolArtifact

export type ArtifactFamily = ArtifactVM['family']
