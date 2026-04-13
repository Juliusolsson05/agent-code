// Per-session tmux configuration applied via `tmux set -t <name>`
// immediately after `tmux new-session`. These flags are the entire
// reason the user never sees tmux: status bar off, mouse off,
// aggressive-resize on so a smaller secondary attacher (P4 dispatch)
// doesn't shrink the primary view.
//
// Keep this list authoritative — every code path that creates a
// ccshell tmux session must apply these. Drift here would let the
// status bar leak into the renderer's xterm view.

export const TMUX_SESSION_FLAGS: ReadonlyArray<readonly [string, string]> = [
  // Hide the persistent status bar. Without this the renderer would
  // see one row eaten by tmux's bottom chrome.
  ['status', 'off'],
  // Don't intercept mouse events — the renderer wants those.
  ['mouse', 'off'],
  // Per-window: when multiple clients are attached at different sizes,
  // size to each client independently rather than the smallest. This
  // becomes important in P4 (dispatch+mirror) but costs nothing now.
  ['aggressive-resize', 'on'],
]
