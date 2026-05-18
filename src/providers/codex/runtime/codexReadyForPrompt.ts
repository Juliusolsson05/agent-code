export function isCodexReadyForPromptScreen(screen: string): boolean {
  if (!screen) return false
  // WHY this readiness gate is intentionally screen-based:
  //
  // `CodexSession.start()` only proves that the PTY and rollout watcher are
  // wired. It does not prove Codex's TUI is accepting composer input. Fresh
  // sessions can still be sitting on startup chrome or the trust dialog, and
  // a bracketed paste written in that window is simply lost. Orchestration
  // creates Codex children and immediately sends their bootstrap prompt, so it
  // needs the same kind of provider-specific "the composer exists now" signal
  // that Claude gets from its paste-placeholder wait.
  //
  // Codex does not expose a structured "composer ready" event here. The idle
  // screen is the narrowest local signal available: the footer has the model
  // row, the composer prompt marker is visible, and known blocking startup
  // dialogs are absent. This is deliberately a readiness heuristic, not a
  // general activity detector; if Codex changes this chrome, timing out is
  // safer than pretending an orchestration prompt was delivered.
  if (screen.includes('Do you trust the contents of this directory')) return false
  if (screen.includes('Yes, continue') && screen.includes('No, quit')) return false
  if (screen.includes('Working (')) return false
  if (screen.includes('Allow command') || screen.includes('allow command')) return false
  if (screen.includes('Approve') && screen.includes('Deny')) return false
  if (screen.includes("don't ask again")) return false
  if (!/(^|\n)›\s/.test(screen)) return false
  return screen.includes(' · ')
}
