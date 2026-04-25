export type SetupToolId =
  | 'brew'
  | 'claude'
  | 'codex'
  | 'git'
  | 'tmux'
  | 'mitmdump'

export type SetupToolStatus = {
  id: SetupToolId
  label: string
  required: boolean
  found: boolean
  path: string | null
  installable: boolean
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
