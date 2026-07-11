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
