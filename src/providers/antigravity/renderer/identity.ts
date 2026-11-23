// Antigravity provider identity descriptor. See the Claude counterpart for the
// role these fields play across the app's identity surfaces (glyphs, badges,
// spawn pickers, palette commands).

export const ANTIGRAVITY_IDENTITY = {
  /** Antigravity's upward mark. */
  glyph: '▲',
  shortLabel: 'Antigravity',
  spawnDescription: 'Google Antigravity (agy) session',
  // `agy --conversation <id>` opens the SAME conversation in agy's own TUI:
  // ACP sessions and TUI sessions share one store (session/list returns both,
  // recorded on agy 1.5.15). buildProviderResumeCommand prefixes `cd <cwd> &&`.
  resumeCommand: (quotedSessionId: string) => `agy --conversation ${quotedSessionId}`,
  // No splitShortcutKey: chords are scarce; palette split commands derive
  // automatically (#394 phase 4).
} as const
