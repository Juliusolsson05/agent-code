# A raw PTY view survives a same-id wake (#1281)

## Evidence
- `cleanupSessionState` (process exit) deleted `agentPtyAttachCounts[sessionId]` and `agentPtyRestoreSizes[sessionId]`.
- AgentTerminalLeaf attaches once per sessionId (effect deps `[sessionId]`), and is released only by its own unmount (`detachAgentPty`).
- A same-id wake (`recover` from deliverTextToSession, control/agents, requestServerRestart) starts a new process under the same id. `pty-data` forwarding is gated on `count > 0`, so the new process's bytes were buffered and never sent, and the mounted xterm stayed frozen.
- Reproduced through the real manager: attach, exit, recover the same id, then the new process's output is not forwarded.

## Change
The attach count and restore size describe the renderer's VIEW, not the process. Process cleanup leaves them alone, and the view's own `detachAgentPty` (on unmount, including pane close) remains the only release.

## Residuals (not in this PR)
- Plain terminals: `terminalAttached` has no detach call at all and is only cleared by cleanup. Keeping it would leak an id per closed terminal, so the terminal half needs a renderer detach first. Recorded on #1281.
- A renderer reload or crash never runs the leaf cleanup (#1283 item 3). That predates this change, but it now also survives a process exit.

## Test
`sessionManager.ptyAttachWake.test.ts`: attach, exit, recover the same id; the fresh output is forwarded, and the view's detach still ends it. Red on main.
