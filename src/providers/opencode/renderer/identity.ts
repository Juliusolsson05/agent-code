// OpenCode provider identity descriptor (#406, wiring step 2). See the
// Claude counterpart for the role these fields play across the app's
// identity surfaces (glyphs, badges, spawn pickers, palette commands).

export const OPENCODE_IDENTITY = {
  /** Matches opencode's own prompt marker aesthetic. */
  glyph: '◍',
  shortLabel: 'OpenCode',
  spawnDescription: 'server-based coding agent session',
  /** Verified against OpenCode CLI 1.18.27: the no-subcommand TUI accepts
   *  `--session`/`-s` and resumes the named native session. */
  resumeCommand: (quotedSessionId: string) => `opencode --session ${quotedSessionId}`,
  // No splitShortcutKey: chords are scarce; palette split commands
  // derive automatically (#394 phase 4).
} as const
