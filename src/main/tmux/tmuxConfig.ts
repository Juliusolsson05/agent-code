// Per-session tmux configuration applied via `tmux set -t <name>`
// immediately after `tmux new-session`. These flags keep tmux chrome invisible
// while preserving terminal scrollback and TUI mouse scrolling.
//
// Keep this list authoritative — every code path that creates a
// Agent Code tmux session must apply these. Drift here would let the
// status bar leak into the renderer's xterm view.

export const TMUX_SESSION_FLAGS: ReadonlyArray<readonly [string, string]> = [
  // Hide the persistent status bar. Without this the renderer would
  // see one row eaten by tmux's bottom chrome.
  ['status', 'off'],
  // WHY mouse ON (#1549): `tmux attach` switches the outer xterm onto the
  // alternate screen (?1049h), where xterm has no scrollback buffer. With
  // `mouse off`, xterm's MouseService._handlePassiveWheel turns every wheel
  // scroll into Up/Down arrow keys instead of scrolling tmux's scrollback —
  // breaking scrolling in plain shells and inline-mode TUIs like `agy`. With
  // `mouse on`, wheel-up enters tmux copy-mode to scroll real scrollback,
  // wheel-down exits at the bottom, and alt-screen apps that request mouse
  // tracking (?1000h/?1002h/?1003h/?1006h) still receive SGR wheel events
  // directly. Native xterm drag-selection remains available with Option/Alt.
  //
  // Deliberately NOT setting `set-clipboard`: in tmux it is a SERVER option
  // (ignoring `-t <name>`), so setting it would mutate the user's shared
  // default tmux server and weaken tmux 3.6a's `external` default.
  ['mouse', 'on'],
  // Per-window: when multiple clients are attached at different sizes,
  // size to each client independently rather than the smallest. This
  // becomes important in P4 (dispatch+mirror) but costs nothing now.
  ['aggressive-resize', 'on'],
]
