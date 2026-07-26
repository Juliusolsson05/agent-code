// Claude provider identity descriptor (#394 phase 2c-2).
//
// WHY this exists: glyphs, short labels, spawn-picker descriptions and
// the copyable resume command were hand-written ternaries scattered
// across sessionDisplay, formatWorktreeDump, TileLeaf/labels,
// providerResumeCommand, PathPickerModal and NewAgentPlacementOverlay
// — every one of them a place a third provider silently didn't exist
// (#394 §7). They now live here, surfaced through the renderer
// capability registry, so registering a provider makes it show up in
// every identity surface at once.

export const CLAUDE_IDENTITY = {
  /** Dense-list glyph. Matches CC's own transcript marker. */
  glyph: '⏺',
  /** Short badge/toggle label. The long display name ('Claude Code')
   *  is the registry's `name` field. */
  shortLabel: 'Claude',
  /** One-line description for spawn pickers. */
  spawnDescription: 'full agent session',
  /**
   * Provider-specific resume invocation. Takes the ALREADY shell-
   * quoted provider session id — quoting policy (and the `cd` prefix)
   * stays with the call site so this stays a pure string template.
   * Claude resumes via a flag; Codex via a subcommand — the split
   * that used to be a hand-written ternary in providerResumeCommand.
   */
  resumeCommand: (quotedSessionId: string) => `claude --resume ${quotedSessionId}`,

  /**
   * Feature capabilities (governance plan Phase 5). Claude has a saved-session
   * index, a transcript adapter used by both rewind and duplicate, a verified
   * `claude --resume` form, and a translation edge to Codex.
   */
  features: {
    savedSessionListing: true,
    transcriptRewind: true,
    transcriptDuplicate: true,
    switchTargets: ['codex'],
    verifiedExternalResumeCommand: true,
  },
} as const
