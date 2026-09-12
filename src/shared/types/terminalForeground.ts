// Foreground-process observation for plain shell sessions (#865).
//
// WHY this is its own boundary-neutral module rather than a field on
// AgentProcessState: agent `process-state` is consumed by the remote phone tap
// and the session recorder, and neither may learn anything about terminals
// (#866). Terminal activity therefore travels on its own channel. Its types live
// where main, preload and renderer can all import them without importing each
// other.

/** One raw observation from a backend. */
export type TerminalForegroundSample = {
  /** Process name as the OS reports it: tmux `pane_current_command`, or
   *  node-pty's `process` for a direct PTY. Null when the backend cannot say. */
  command: string | null
  /** Live working directory when the backend can report one (tmux only). */
  cwd: string | null
}

/** A classified observation: `busy` means something other than the shell owns
 *  the terminal's foreground. */
export type TerminalForegroundState = {
  busy: boolean
  command: string | null
  cwd: string | null
}

export type TerminalForegroundEvent = { sessionId: string } & TerminalForegroundState
