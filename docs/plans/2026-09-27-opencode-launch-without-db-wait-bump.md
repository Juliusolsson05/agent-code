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
