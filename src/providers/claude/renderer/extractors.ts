// Pure data extractors for Claude wire shapes — NO JSX. The artifact
// resolve layer (src/renderer/src/features/feed/ui/resolve/) calls
// these to normalize provider-specific payloads into ArtifactVMs; the
// cards never see provider wire shapes. Keeping extraction here (and
// JSX out) is the provider seam of the 2026-07 RENDER rewrite: a
// provider can never fork the visual language again, only feed it.

/** Parsed slash-command invocation envelope. Claude Code records a
 *  slash command as a user text block containing XML-ish tags. */
export type SlashCommandEnvelope = {
  name: string
  message: string | null
  args: string | null
}

// WHY order-insensitive per-tag regexes instead of one combined match:
// verified against real transcripts (2026-07-11) — the tag ORDER
// VARIES between Claude Code versions: older sessions emit
// <command-name> first, newer ones emit <command-message> first. A
// positional grammar would silently stop matching on the next
// upstream shuffle. Tags are single-occurrence per block in every
// observed sample; [\s\S] because <command-args> carries raw user
// text including newlines.
const COMMAND_NAME_RE = /<command-name>([\s\S]*?)<\/command-name>/
const COMMAND_MESSAGE_RE = /<command-message>([\s\S]*?)<\/command-message>/
const COMMAND_ARGS_RE = /<command-args>([\s\S]*?)<\/command-args>/
const LOCAL_STDOUT_RE = /<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/

/** Parse a user text block that is a slash-command invocation.
 *  Returns null when the block carries no <command-name> tag —
 *  callers fall through to normal user-text rendering, so this can
 *  never make a prompt LESS readable. */
export function parseSlashCommandEnvelope(text: string): SlashCommandEnvelope | null {
  const name = COMMAND_NAME_RE.exec(text)?.[1]?.trim()
  if (!name) return null
  const message = COMMAND_MESSAGE_RE.exec(text)?.[1]?.trim() || null
  const args = COMMAND_ARGS_RE.exec(text)?.[1]?.trim() || null
  return { name, message, args }
}

/** Parse a user text block that is ONLY a local-command stdout record
 *  (Claude Code emits it as a SEPARATE user entry following the
 *  invocation). Content may carry ANSI escapes — real sample:
 *  "Set model to \x1b[1mFable 5\x1b[22m…" — so render it through an
 *  ANSI-aware surface. Returns null when the tag is absent. */
export function parseLocalCommandStdout(text: string): string | null {
  const m = LOCAL_STDOUT_RE.exec(text)
  if (!m) return null
  return m[1] ?? ''
}

/** Does this user text block belong to the slash-command surface at
 *  all (invocation OR stdout record)? Cheap gate so the hot user-text
 *  path doesn't run three regexes on every ordinary prompt. */
export function isSlashCommandText(text: string): boolean {
  return text.includes('<command-name>') || text.includes('<local-command-stdout>')
}

// ---------------------------------------------------------------------------
// Edit / MultiEdit / Write input extraction (committed + live-partial)
// ---------------------------------------------------------------------------

import { parseJsonRecord } from '@shared/lib/asRecord'

/** Committed Edit input — missing fields become empty strings so the
 *  diff still renders (as all-added / all-removed) without crashing.
 *  Moved from ClaudeRows.tsx editInput. */
export function editInput(input: unknown): {
  filePath: string
  oldString: string
  newString: string
} {
  const rec = (input ?? {}) as Record<string, unknown>
  return {
    filePath: typeof rec.file_path === 'string' ? rec.file_path : '',
    oldString: typeof rec.old_string === 'string' ? rec.old_string : '',
    newString: typeof rec.new_string === 'string' ? rec.new_string : '',
  }
}

export function multiEditInput(input: unknown): {
  filePath: string
  edits: Array<{ oldString: string; newString: string }>
} {
  const rec = (input ?? {}) as Record<string, unknown>
  const edits = Array.isArray(rec.edits) ? (rec.edits as Array<Record<string, unknown>>) : []
  return {
    filePath: typeof rec.file_path === 'string' ? rec.file_path : '',
    edits: edits.map(e => ({
      oldString: typeof e.old_string === 'string' ? e.old_string : '',
      newString: typeof e.new_string === 'string' ? e.new_string : '',
    })),
  }
}

// [#285] Extract a CLOSED top-level JSON string field from a partial
// inputJson buffer — one whose closing quote has already streamed. The
// regex body `(?:[^"\\]|\\.)*` tolerates escaped quotes and embedded
// newlines, so it only matches a fully-arrived value. Used ONLY during
// the brief streaming window before the whole object is JSON-parseable;
// the moment parseJsonRecord succeeds the authoritative parse takes
// over. A value literally containing the key text mid-stream could
// mis-match transiently, but it self-corrects on the next delta.
// Moved from BlockRow.tsx.
export function extractClosedJsonString(raw: string, key: string): string | null {
  const re = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`)
  const m = re.exec(raw)
  if (!m) return null
  try {
    return JSON.parse(`"${m[1]}"`) as string
  } catch {
    return null
  }
}

// [#285] Build the committed Edit/MultiEdit input object from a live
// partial buffer, so the streaming path renders the SAME diff card the
// committed transcript uses. Returns null until at least file_path has
// streamed — never flash an empty "(no changes)" card. Moved from
// BlockRow.tsx claudeLiveEditInput.
export function partialEditInput(
  raw: string,
  parsed: Record<string, unknown> | null,
  toolName: string,
): Record<string, unknown> | null {
  if (parsed) return parsed
  const full = raw ? parseJsonRecord(raw) : null
  if (full) return full
  if (!raw) return null
  const filePath = extractClosedJsonString(raw, 'file_path')
  if (!filePath) return null
  if (toolName === 'MultiEdit') {
    // The edits array can't be reliably half-parsed; show the header
    // now (file path) and let the authoritative parse fill in the
    // per-edit diff chunks the instant the whole object completes.
    return { file_path: filePath, edits: [] }
  }
  return {
    file_path: filePath,
    old_string: extractClosedJsonString(raw, 'old_string') ?? '',
    new_string: extractClosedJsonString(raw, 'new_string') ?? '',
  }
}
