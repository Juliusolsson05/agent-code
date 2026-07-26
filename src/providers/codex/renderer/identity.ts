// Codex provider identity descriptor (#394 phase 2c-2). See the
// Claude counterpart for why this exists.

export const CODEX_IDENTITY = {
  /** Dense-list glyph. Matches Codex's composer marker. */
  glyph: '›',
  shortLabel: 'Codex',
  spawnDescription: 'OpenAI coding agent session',
  /** Codex resumes via a subcommand (not a flag) — and the id must be
   *  appended AFTER any config flags in real spawns; for the copyable
   *  command there are no flags, so the plain form is correct. */
  resumeCommand: (quotedSessionId: string) => `codex resume ${quotedSessionId}`,
  /** Alt-<key> chord for "split with this provider" (uppercase
   *  KeyboardEvent.code letter). The DEFAULT_PROVIDER uses the generic
   *  split chords instead; additional providers without a key get
   *  palette-only split commands. */
  splitShortcutKey: 'C',

  /**
   * Feature capabilities (governance plan Phase 5). Mirrors Claude: saved
   * sessions, a transcript adapter, a verified `codex resume` form, and the
   * reverse translation edge.
   */
  features: {
    savedSessionListing: true,
    transcriptRewind: true,
    transcriptDuplicate: true,
    switchTargets: ['claude'],
    verifiedExternalResumeCommand: true,
  },
} as const
