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

} as const
