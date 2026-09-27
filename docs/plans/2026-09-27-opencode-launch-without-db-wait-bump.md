# App side of launching OpenCode without waiting on `opencode db path` (#1114)

Short plan: a pointer bump plus the host contract the package needs. The design, evidence and review history are in the package: `packages/opencode-terminal-headless/docs/plans/2026-09-27-launch-without-db-path-wait.md` (opencode-terminal-headless#10, merged `7a009541`).

## Outcome
An OpenCode pane's TUI spawns without waiting up to 20 s for the database-path lookup during a restore storm. The durable (committed-transcript) channel opens when the lookup lands. Nothing committed in the meantime is lost silently: it is proven absent or reported as a possible gap, which the renderer heals by re-reading history (#1117).

## Change
- `packages/opencode-terminal-headless` goes to `7a009541`. No lockfile change: the app resolves the package through a path alias, not a `file:` dependency, and the package's own dependencies did not change.
- **`OpencodeTerminalSession`: the host contract (recheck2 a/b).**
  1. `tuiOutput` is latched in the PTY data subscription made right after spawn, and passed to the headless as `tuiOutputSeen`.
  2. Terminal input (`write`: keystrokes, pastes) is **held** until the TUI's first output, then written in order. Programmatic prompts go through the server and the package gates them. So nothing that can make OpenCode commit reaches the PTY before it paints, and the package's "no output yet, nothing committed" proof holds. Held input for a TUI that never paints is dropped on stop.
- **Renderer test harness:** `AdapterPty` drops the data subscription it duplicated (the package's `FakePty` has it now, and the two private fields conflicted), and its launch-shape docs are refreshed.

## Tests
`opencodeTerminalSession.test.ts`, with the real headless recording its options. Each test fails on main's adapter:
- the latch is false until the first output, then true;
- input written before paint is held, then written in order, with later input passing through;
- held input is dropped when the pane stops.

## Verification boundary
Unit and system tests with fake PTYs and the real package. The app is not launched. The real TUI's "paint before reading input" ordering is the package's stated assumption (recorded sessions support it). Holding input makes the host side of it true by construction.

## Review round 1 and steering q97
- **b and c (blocker, package):** after a ladder recovery the late report fired before a BUSY-deferred reader positioned, so the app's one heal could run too early and a turn was lost. Fixed in the package (opencode-terminal-headless#11: the report comes from `onPositioned`). This PR bumps to that merge.
- **b (major, app): the pre-paint hold was unbounded, and exit did not clear it.**
  - **Bounded:** 256 chunks (the renderer's own pre-attach queue cap) and 64 KiB. Past either bound the NEW input is refused, so what was accepted stays in order.
  - **Refused, never silently dropped:** `OpencodeTerminalSession.write` returns `false`, `AgentSession.write` may return `false`, and `SessionManager.write` reports it. `AgentTerminalLeaf` shows a coalesced pane toast ("That input didn't reach the agent…") when `sendInput` answers `false`. The same toast now covers the older refusals keystrokes were silently dropped for (no backend, a prompt delivery holding the composer).
  - **Cleared on exit** as well as on stop.
  - Tests (each red on the previous head): a 64 KiB paste refused while earlier input is kept; the 257th chunk refused; exit clears the hold; the manager reports a refusal; the leaf toasts once.

## Steering q100: the pre-attach flush and neutral copy
- **The pre-attach flush ignored `sendInput` → false.** It is the pane's largest single write (up to 256 queued chunks), so it is the one most likely to exceed the bounded pre-paint hold, and it was dropped silently.
  - It now goes through the same coalesced refusal reporter as the forwarder.
- **Ruling: a refusal is final, not retried.** A retry could land after newer keystrokes, out of order. The user is told which input failed: "What you typed while the terminal was attaching didn't reach the agent."
- **The forwarder's copy is neutral:** "That input didn't reach the agent." Main answers only a boolean (no backend, a delivery reservation, a full pre-paint hold), so naming any one cause would be false for the others.
- **Test:** a Submit queued before attach, with `sendInput` resolving false on flush, shows the flush message. Red with the flush reverted.
