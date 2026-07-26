// OpenCode provider identity descriptor (#406, wiring step 2). See the
// Claude counterpart for the role these fields play across the app's
// identity surfaces (glyphs, badges, spawn pickers, palette commands).

export const OPENCODE_IDENTITY = {
  /** Matches opencode's own prompt marker aesthetic. */
  glyph: '◍',
  shortLabel: 'OpenCode',
  spawnDescription: 'server-based coding agent session',
  /** Runtime resume is native (server session id); the copyable CLI
   *  form needs verification against the opencode CLI before the
   *  branch merges (#406 §C-4). */
  resumeCommand: (quotedSessionId: string) => `opencode --session ${quotedSessionId}`,
  // No splitShortcutKey: chords are scarce; palette split commands
  // derive automatically (#394 phase 4).

  /**
   * Feature capabilities (governance plan Phase 5).
   *
   * Everything is FALSE today, and that is the correction the plan asks for
   * rather than a slight. OpenCode has no saved-session listing in main, no
   * transcript adapter (so rewind and duplicate have nothing to operate on),
   * no switch edge in either direction, and the resumeCommand below is an
   * unverified guess — see its own comment. Declaring agent-hood previously
   * granted all five features implicitly, so the commands appeared enabled and
   * then did nothing.
   *
   * Flip these individually as each adapter becomes real; do not flip them as
   * a group.
   */
  features: {
    savedSessionListing: false,
    transcriptRewind: false,
    transcriptDuplicate: false,
    switchTargets: [],
    verifiedExternalResumeCommand: false,
  },
} as const
