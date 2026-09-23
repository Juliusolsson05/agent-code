// Wire types shared by main, preload and renderer for the browser pocket.

/** A dev server a lane's own processes are listening on (LanePortWatcher). */
export type LanePort = {
  port: number
  pid: number
  url: string
  /** From one `GET /`: html = something to show; other = listed last. */
  kind: 'html' | 'other'
}

export type PocketFlags = {
  enabled: boolean
  allowEvaluate: boolean
}

/** Who is driving a pocket right now (controller → renderer). */
export type PocketDrivingEvent = {
  pocketId: string
  state: 'agent' | 'user-paused' | null
  action?: string
  /** Last agent pointer position in page CSS pixels, for the ghost cursor. */
  point?: { x: number; y: number }
}

export type PocketLocalAction = 'reload' | 'hardReload' | 'focusAddress' | 'pick'

export type PocketPickResult = {
  url: string
  selector: string
  role: string
  name: string
  width: number
  height: number
  /** JPEG data URL of the element, when capture worked. */
  image: string | null
}

export type PortWatchSession = {
  sessionId: string
  /** tmux session names of terminals attributed to this lane. Their panes
   * descend from the daemonized tmux SERVER, never from Electron, so main
   * resolves them through `tmux list-panes` (core/lanePorts.ts). */
  tmuxNames: string[]
  /** Direct-PTY terminal sessions attributed to this lane (main resolves pids). */
  terminalSessionIds: string[]
}

/** A key pressed while a pocket page had focus, replayed into the app's router. */
export type ForwardedKey = { key: string; code: string; meta: boolean; ctrl: boolean; alt: boolean; shift: boolean }
