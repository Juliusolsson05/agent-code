import { accessSync, constants as fsConstants } from 'node:fs'

// pickShell — implements the fallback chain terminalSession's comment
// always *claimed* ($SHELL → /bin/zsh → /bin/bash → /bin/sh) but never
// actually had (#495 A8): the old expression was `$SHELL ?? '/bin/zsh'`
// with NO existence check, so a stale/uninstalled $SHELL (deleted
// homebrew fish, chsh to a removed binary, restored dotfiles from
// another machine) produced a PTY that died instantly with an
// exit-that-looks-like-a-crash instead of falling back to a shell that
// exists.
//
// Sync on purpose: it runs once per PTY spawn and accessSync on 1-4
// local paths is nanoseconds against a fork+exec.
//
// Module-level memo: the answer cannot change within a process lifetime
// in any way we care about (nobody deletes /bin/zsh mid-session, and a
// $SHELL fixed mid-session is picked up on next app launch).
let memo: string | null = null

export function pickShell(preferred?: string): string {
  // Explicit caller choice is not second-guessed — a caller passing a
  // concrete shell (e.g. TerminalSessionOptions.shell in tests or a
  // future per-pane shell setting) owns the consequences; probing would
  // silently substitute a different shell than the one requested.
  if (preferred) return preferred
  if (memo) return memo
  for (const candidate of [process.env.SHELL, '/bin/zsh', '/bin/bash', '/bin/sh']) {
    if (!candidate) continue
    try {
      accessSync(candidate, fsConstants.X_OK)
      memo = candidate
      // One debug line per process so a support bundle shows which shell
      // every PTY in the run actually used — invaluable when "terminal
      // panes are broken" reports come from machines with exotic $SHELL.
      // eslint-disable-next-line no-console
      console.debug(`[pickShell] resolved shell: ${candidate} (SHELL=${process.env.SHELL ?? '(unset)'})`)
      return candidate
    } catch {
      // next candidate
    }
  }
  // Hail-mary: nothing probed as executable (exotic sandbox / broken
  // /bin). Return /bin/sh anyway so the spawn error surfaces through the
  // PTY's normal exit path rather than throwing from here with a less
  // actionable stack.
  memo = '/bin/sh'
  return memo
}
