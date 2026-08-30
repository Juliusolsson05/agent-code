import type { AgentProviderKind } from '@shared/types/providerKind.js'
import type { SessionDisplayIdentity } from '@shared/types/sessionDisplayIdentity.js'

// The session prompt index wire shape.
//
// WHY this lives in @shared rather than beside the scanner in
// `src/main/sessionIndex.ts`: it previously existed twice — once there and once
// hand-copied into `src/preload/api/types.ts` — and the two were free to drift
// silently across the process boundary. #96 was partly a symptom of exactly
// that kind of duplication: the same concept described by two types that nobody
// was obliged to keep in agreement. Main owns the scanning; the SHAPE is a
// contract, so it belongs at the neutral boundary both sides already import.

export type SessionIndexPrompt = {
  text: string
  /** Epoch ms if the entry's ISO timestamp parsed, else null. */
  ts: number | null
}

export type SessionIndexEntry = {
  /** Provider-side uuid (Claude) or rollout uuid (Codex). Stable;
   *  used as the resume argument. */
  providerSessionId: string
  kind: AgentProviderKind
  /** Cwd the session was recorded in (from session_meta for Codex;
   *  from the first entry's cwd field for Claude). Falls back to
   *  empty string if not discoverable. */
  cwd: string
  /** File mtime epoch ms. Primary sort key for the recent view. */
  lastModified: number
  /** Legacy one-line summary from the provider listers.
   *
   *  DEPRECATED for display (#96) — read `identity.label` instead. This field
   *  is a pre-flattened `customTitle ?? lastPrompt ?? firstPrompt` for Claude
   *  and a first-user-message-or-hex-id for Codex, which is precisely why the
   *  two providers used to name the same conversation differently. It is kept
   *  because search ranking and non-display callers still read it; it must not
   *  come back as a row label. */
  summary: string
  /** Up to the last N user prompts (newest first). Empty array
   *  when a session exists on disk but has no visible user prompts
   *  (rare — fresh session with only assistant bootstrap text). */
  recentUserPrompts: SessionIndexPrompt[]
  /** Count of matched prompts when returned from search, else 0. */
  matchCount: number
  /** The one identity every picker renders. Derived once in main. */
  identity: SessionDisplayIdentity
}
