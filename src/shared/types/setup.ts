export type SetupToolId =
  | 'brew'
  | 'claude'
  | 'codex'
  | 'git'
  | 'tmux'
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

export type SetupInstallTarget = 'tmux' | 'mitmproxy'

export type SetupInstallResult = {
  ok: boolean
  target: SetupInstallTarget
  output: string
  check: SetupCheckResult
}
