# Terminals: stop replay from answering the provider, coalesce keystrokes

Fixes #745. Refs #103, #390.

## Problem

Attaching an inline terminal writes up to 512 KiB of replay into xterm in
one go. xterm answers every terminal query embedded in that stream —
cursor-position reports, device attributes, colour queries — through
`term.onData`, and each chunk became its own `ipcRenderer.invoke`. One
attach today produced 21,795 `session:input` calls in 15 s and a 7.4 s
renderer long task, and main wrote thousands of stale `ESC[row;colR`
replies into the agent's stdin. While attached, the trickle continues at
~5 Hz because the renderer xterm is the only thing that ever answers the
TUI's queries.

## Design

A small `terminalInputForwarder` shared by the three xterm hosts:

- `replay(term, chunks)` writes the replay content and holds a "replaying"
  latch until xterm's write callback confirms it has been parsed. Data xterm
  emits while the latch is held is a reply to content the provider already
  moved past, and is dropped. Keystrokes typed during that ~100 ms window
  are dropped with it — the pane has not painted yet.
- `onData(data)` outside a replay coalesces chunks emitted in the same tick
  into one `sendInput` (a paste, or a burst of query replies, arrives as
  many chunks), keeping keystroke latency at one microtask.
- Acknowledgement of user activity only happens for data that was actually
  forwarded, so stale replies no longer count as interaction.

Not in scope: answering DSR/DA inside the headless terminal so responses are
consistent whether or not a pane is attached (noted in #745); moving the
keystroke transport from `invoke` to `send`.

## Verification

- `terminalInputForwarder.test.ts`: data emitted during a replay is dropped
  and none is sent; data after the replay resolves is sent; chunks in one
  tick are coalesced into one send in order; an empty replay resolves
  without holding the latch.
- Existing `AgentTerminalLeaf` renderer test unchanged.
- `npx tsc -b`.
