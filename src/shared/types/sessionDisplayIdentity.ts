import type { AgentProviderKind } from '@shared/types/providerKind.js'
import type { SessionInfo } from '@shared/types/session.js'

// Session display identity — the single answer to "which past conversation is
// this?" for every surface that lets the user pick one.
//
// WHY THIS EXISTS (#96)
// ---------------------
// Three surfaces let a user pick a past session — the PathPicker resume list,
// the command palette, and prompt search — and each rendered a different
// identity for the same conversation. The obvious reading is that this is a
// renderer problem. It is not, and fixing it in the renderer is impossible.
//
// The identity decision was made in the provider listers and flattened into a
// lossy `summary: string` before any UI saw it:
//
//   * Claude preferred `customTitle ?? lastPrompt ?? firstPrompt` — the LAST
//     prompt. Codex used the FIRST user message. The same conversation
//     therefore renamed itself when moved between providers, which this app
//     supports as a headline feature.
//   * Codex wrote a truncated hex id INTO `summary` when it found no user text
//     (codex-headless SessionList.ts). A renderer holding that string cannot
//     distinguish a real title from a fallback, so "show the user when they are
//     looking at a fallback" was unimplementable against the old contract.
//   * Claude DROPPED a session with no derivable summary from the list, while
//     Codex showed it. The providers disagreed about list membership, not just
//     labels.
//
// So the fix is not a shared component with a shared string. It is a shared
// record that keeps the PROVENANCE of the label. `labelSource` is the
// load-bearing field here: it is what lets a row mark a fallback as a fallback,
// what lets a test assert the ladder rung-by-rung, and what removes the need to
// guess whether a given string is secretly a session id.
//
// Everything below is pure and dependency-free so main derives it once, the
// renderer only consumes it, and the ladder is unit-testable without a
// filesystem.

/** Which rung of the ladder produced `label`. Ordered best → worst. */
export type SessionLabelSource =
  | 'custom-title'
  | 'first-prompt'
  | 'last-prompt'
  | 'cwd'
  | 'session-id'

/** The two rungs that are not really a name. A picker should mark these
 *  visually so the user knows they are looking at a stand-in rather than
 *  something the conversation actually said. */
const FALLBACK_SOURCES: ReadonlySet<SessionLabelSource> = new Set<SessionLabelSource>([
  'cwd',
  'session-id',
])

export function isFallbackLabel(source: SessionLabelSource): boolean {
  return FALLBACK_SOURCES.has(source)
}

export type SessionDisplayIdentity = {
  /** Provider-side uuid (Claude) or rollout uuid (Codex). The resume argument. */
  providerSessionId: string
  kind: AgentProviderKind
  cwd: string | null
  /** Already resolved through the ladder. Never empty. */
  label: string
  labelSource: SessionLabelSource
  /** File mtime epoch ms — the sort key every picker already used. */
  lastActivityAt: number
  gitBranch: string | null
}

/** Raw ingredients, before the ladder runs. Providers populate what they can
 *  and leave the rest null; the ladder — not the provider — decides which one
 *  wins. That inversion is the whole point of this module. */
export type SessionIdentityInput = {
  providerSessionId: string
  kind: AgentProviderKind
  cwd?: string | null
  customTitle?: string | null
  firstPrompt?: string | null
  lastPrompt?: string | null
  lastActivityAt: number
  gitBranch?: string | null
}

// Long prompts are pasted walls of text often enough that an untruncated label
// would blow out every row. The picker shows one line; the conversation itself
// is one click away.
const LABEL_MAX_CHARS = 120

/** Truncated-id length. Matches what the old surfaces displayed, so a user who
 *  learned to recognise `8d6926a5` keeps that recognition. */
const ID_LABEL_CHARS = 8

function clean(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null
  // Collapse newlines: a label is one line, and a multi-line first prompt would
  // otherwise render as a tall row or get silently clipped by CSS with no
  // ellipsis to signal it.
  const collapsed = value.replace(/\s+/g, ' ').trim()
  if (!collapsed) return null
  if (collapsed.length <= LABEL_MAX_CHARS) return collapsed
  return collapsed.slice(0, LABEL_MAX_CHARS).trimEnd() + '…'
}

/** Last non-empty path segment. Duplicated deliberately rather than imported
 *  from the renderer's `sessionDisplay.ts`: this module is main-side and shared,
 *  and reaching into a renderer feature folder for four lines would invert the
 *  dependency direction. */
function cwdBasename(cwd: string | null | undefined): string | null {
  if (!cwd) return null
  const parts = cwd.replace(/\/+$/, '').split('/').filter(Boolean)
  return parts[parts.length - 1] ?? null
}

/**
 * The ladder. One order, both providers.
 *
 * WHY first-prompt outranks last-prompt (a change from Claude's old behaviour):
 * users recognise a conversation by how it STARTED, not by whatever it happened
 * to be doing when they last touched it — a last-prompt label mutates as the
 * session continues, so the same conversation is unrecognisable an hour later.
 * Codex already keyed on the first message; adopting it everywhere also makes a
 * provider switch identity-preserving.
 *
 * WHY a nameless session still gets a label instead of being dropped: Claude's
 * lister used to `return null` when no summary could be derived, making those
 * sessions invisible in the resume picker. A session you cannot see is strictly
 * worse than one labelled by its folder — the id is still resumable.
 */
export function buildSessionDisplayIdentity(
  input: SessionIdentityInput,
): SessionDisplayIdentity {
  const base = {
    providerSessionId: input.providerSessionId,
    kind: input.kind,
    cwd: input.cwd ?? null,
    lastActivityAt: input.lastActivityAt,
    gitBranch: input.gitBranch ?? null,
  }

  const customTitle = clean(input.customTitle)
  if (customTitle) return { ...base, label: customTitle, labelSource: 'custom-title' }

  const firstPrompt = clean(input.firstPrompt)
  if (firstPrompt) return { ...base, label: firstPrompt, labelSource: 'first-prompt' }

  const lastPrompt = clean(input.lastPrompt)
  if (lastPrompt) return { ...base, label: lastPrompt, labelSource: 'last-prompt' }

  const basename = cwdBasename(input.cwd)
  if (basename) return { ...base, label: basename, labelSource: 'cwd' }

  return {
    ...base,
    label: input.providerSessionId.slice(0, ID_LABEL_CHARS),
    labelSource: 'session-id',
  }
}

/**
 * Adapt a provider lister's `SessionInfo` into ladder ingredients.
 *
 * WHY this adapter exists rather than changing the listers to emit the
 * ingredients directly: Codex's lister lives in the `codex-headless` submodule,
 * a separate repository. Making it emit `{ label, labelSource }` is the right
 * end state, but it would block every UI fix in this issue behind a cross-repo
 * PR, a submodule bump, and a lockfile resync. This adapter recovers the
 * ingredients from what the listers already return, in-app and today.
 */
export function identityInputFromSessionInfo(
  info: SessionInfo,
  kind: AgentProviderKind,
): SessionIdentityInput {
  const summary = clean(info.summary)
  const customTitle = clean(info.customTitle)
  const firstPrompt = clean(info.firstPrompt)

  if (kind === 'codex') {
    // Codex populates only `summary`, and it is the FIRST user message — except
    // when the lister found no user text at all, where it writes
    // `sessionId.slice(0, 8)` into that same field (codex-headless
    // SessionList.ts:250,264).
    //
    // WHY comparing against the id is sound rather than a guess: we control
    // both sides of this comparison, and the alternative — trusting the string —
    // renders a hex id as if the user had typed it. A user whose first prompt is
    // exactly the 8 leading hex characters of their own rollout id is not a case
    // worth engineering around. Delete this branch once codex-headless returns
    // structured identity; the ladder above needs no change when it does.
    const looksLikeIdFallback =
      summary !== null && summary === info.sessionId.slice(0, ID_LABEL_CHARS)
    return {
      providerSessionId: info.sessionId,
      kind,
      cwd: info.cwd ?? null,
      firstPrompt: looksLikeIdFallback ? null : summary,
      lastActivityAt: info.lastModified,
      gitBranch: info.gitBranch ?? null,
    }
  }

  // Claude's `summary` is itself a pre-flattened `customTitle ?? lastPrompt ??
  // firstPrompt`. `customTitle` and `firstPrompt` come back as their own fields,
  // so when `summary` matches neither it must be the lastPrompt — that is the
  // only remaining branch of the lister's own expression. Recovering it this way
  // avoids widening SessionInfo (and therefore the submodule's copy of it) just
  // to carry a value that is already implied.
  const lastPrompt =
    summary && summary !== customTitle && summary !== firstPrompt ? summary : null

  return {
    providerSessionId: info.sessionId,
    kind,
    cwd: info.cwd ?? null,
    customTitle,
    firstPrompt,
    lastPrompt,
    lastActivityAt: info.lastModified,
    gitBranch: info.gitBranch ?? null,
  }
}
