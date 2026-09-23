// Pi provider identity descriptor. See the Claude counterpart for the role
// these fields play across the app's identity surfaces (glyphs, badges, spawn
// pickers, palette commands).

export const PI_IDENTITY = {
  /** Pi's own mark (the TUI titles its window "π - <cwd>"). */
  glyph: 'π',
  shortLabel: 'Pi',
  spawnDescription: 'native Pi terminal session',
  // `--session-id <id>` opens that project session (Stage 0 `resume`
  // recording: a relaunch by id reopened the file and appended). Pi's own
  // exit hint prints `pi --session <id>`, which also works but searches other
  // projects on a miss and can ask to fork across directories;
  // `--session-id` stays inside this project, which is what "resume this
  // pane's conversation" means.
  resumeCommand: (quotedSessionId: string) => `pi --session-id ${quotedSessionId}`,
  // No splitShortcutKey: chords are scarce; palette split commands derive
  // automatically.
} as const
