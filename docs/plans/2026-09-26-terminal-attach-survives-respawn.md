# A plain terminal view survives a same-id respawn (#1281 residual, #1283 item 3 for terminals)

## Problem
#1281 is two halves. The agent raw-PTY half shipped in `2ab60d45`, and #1311's review (`6cf6f054`) made each renderer page own its agent-PTY attaches, which covers #1283 item 3 for agents. The plain-terminal half is still open, and its plan (`2026-09-25-pty-attach-survives-wake.md`) recorded it as a residual.
- `SessionManager.terminalAttached` is a Set that `cleanupSessionState` deletes when the shell exits.
- `TerminalLeaf` attaches once per sessionId (effect deps `[sessionId]`), after `ensureSessionLive`.
- A same-id respawn under a still-mounted leaf buffers the new shell's bytes but never forwards them: the xterm stays on the dead shell until a remount. The respawn happens through `recover` with `recoverTmuxName`, from a delivery, a control call, or a wake.
- There is no terminal detach at all, so the flag could not be kept past exit without leaking one id per closed terminal.
- `session:terminal-attach` ignores the sender, so a reloaded or crashed renderer could never release a reference either (#1283 item 3 for terminals).

## Evidence
- Source: `sessionManager.ts` (`terminalAttached` add in `attachTerminal`; delete in `cleanupSessionState`; data forwarding gated on `has`), `ipc/session.ts` (`session:terminal-attach` handler), `TerminalLeaf.tsx` (attach in the `[sessionId]` effect, no detach in its cleanup).
- The agent-half fix and its tests (`sessionManager.ptyAttachWake.test.ts`, `ipc/session.test.ts` "raw PTY attach ownership (#1311)") are the recorded model this copies.

## Decisions (defaults)
- **The attach describes the VIEW, not the process.** `terminalAttached` becomes a count, which process cleanup no longer touches. A new `detachTerminal` releases one reference.
- **A missing session still takes a reference.** A leaf can mount while its shell is down, and the respawn then forwards. A kind mismatch (an agent id) takes none, and the IPC layer records only references main took.
- **Renderer ownership:** the IPC ownership table for agent-PTY attaches becomes one generic per-page table, keyed by view type and session. Terminal attach and detach use it with the page document, like agent PTYs. A reload or destroy releases a page's terminal references too; a stale page's late detach is ignored.
- **TerminalLeaf detaches in its effect cleanup** when its attach resolved; a late attach after unmount detaches itself, as `AgentInlineTerminal` does.
- **No terminal resize restore:** plain terminals have none today, so none is added.

## Tests
- **Manager:** a still-attached terminal view keeps forwarding across exit and a same-id respawn, and its detach ends forwarding. Red on main.
- **IPC:** terminal attaches are released on reload and destroy; a stale page's detach is ignored; a kind-mismatch attach takes no reference.
- **Renderer:** TerminalLeaf detaches on unmount, and a late attach after unmount releases itself.
