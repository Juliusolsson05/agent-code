export const HERMES_IDENTITY = {
  /** The caduceus Hermes uses for itself (its README title is "Hermes Agent ☤"). */
  glyph: '☤',
  shortLabel: 'Hermes',
  spawnDescription: 'chat with your Hermes agent on your server',
  /**
   * There is no local CLI to resume a Hermes conversation with: it lives on
   * the user's server and resumes in-app (Reload Agent). Copy Resume Command
   * stays hidden by `verifiedExternalResumeCommand: false`; this string only
   * exists because the identity type requires one, and says where to look.
   */
  resumeCommand: (quotedSessionId: string) => `# Hermes conversation ${quotedSessionId}: reopen it from Agent Code (Reload Agent)`,
} as const
