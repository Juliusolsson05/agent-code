// External tools whose presence the setup gate inspects. Bundled
// helpers like mitmdump (#119) and tmux (#120) are deliberately NOT
// listed here — they ship inside Agent Code as runtime artifacts and
// have no user-actionable install story.
//
// mitmdump remains in the union temporarily for the follow-up
// cleanup PR that mirrors what #120 does for tmux; #119's
// implementation kept it visible as "Bundled" for one release while
// we proved the resolver works. Once that follow-up lands the union
// shrinks further.
export type SetupToolId =
  | 'brew'
  | 'claude'
  | 'codex'
  | 'git'
  | 'mitmdump'

/**
 * Where a found tool comes from. 'bundled' = Agent Code ships this
 * helper inside the app and the user does not need to install it
 * separately; 'system' = it was discovered on PATH (Homebrew, manual
 * install, etc.). The renderer uses this to drop the install prompt
 * for bundled tools and label them clearly.
 */
export type SetupToolSource = 'bundled' | 'system'

export type SetupToolStatus = {
  id: SetupToolId
  label: string
  required: boolean
  found: boolean
  path: string | null
  installable: boolean
  source?: SetupToolSource
  skipped?: boolean
  detail?: string
}

export type SetupCheckResult = {
  checkedAt: number
  ready: boolean
  blocking: SetupToolId[]
  tools: Record<SetupToolId, SetupToolStatus>
}

// Targets the SetupGate's "Install via Homebrew" button can hand to
// the main process. tmux was removed when its bundled binary became
// the only supported source (#120); mitmproxy is on the same track
// in a follow-up. The follow-up will collapse this to `never` and
// retire the `setup:install` IPC entirely.
export type SetupInstallTarget = 'mitmproxy'

export type SetupInstallResult = {
  ok: boolean
  target: SetupInstallTarget
  output: string
  check: SetupCheckResult
}
