// Grok provider identity descriptor. See the Claude counterpart for the role
// these fields play across the app's identity surfaces (glyphs, badges, spawn
// pickers, palette commands).

export const GROK_IDENTITY = {
  /** Matches Grok's own prompt marker aesthetic. */
  glyph: '⌁',
  shortLabel: 'Grok',
  spawnDescription: 'native Grok Build terminal session',
  // Verified against the controlled-runtime recordings: the terminal attaches
  // to an existing session with `--resume <id>` (contract.md "Root class
  // shape"); `--session-id` on a fresh spawn is unrecorded.
  resumeCommand: (quotedSessionId: string) => `grok --resume ${quotedSessionId}`,
  // No splitShortcutKey: chords are scarce; palette split commands derive
  // automatically (#394 phase 4).
} as const
