# Browser pocket fixtures: recorded, never hand-written

Every file here except this README was produced by
`scripts/browser-pocket/record-fixtures.mts`. Each one carries a provenance
header with the recorder, the date, the platform, and for CDP files the Chrome
version. Re-record rather than edit. `--check` refuses a file that has no
provenance header or that leaks a home path.

Recorded 2026-09-22 on macOS arm64. The app was running two live instances:
the packaged app and a dev app. Both run Claude, Codex and OpenCode agents.

| Files | Recorded from |
|---|---|
| `ps-topology.<tag>.txt` | `ps -axo pid=,ppid=,comm=`, executable basename only, never argv. Covers the Agent Code main subtree plus every tmux pane subtree. |
| `lsof-listen.<tag>.txt` | `lsof -nP -a -iTCP -sTCP:LISTEN -F pcn -p <those pids>` |
| `lsof-listen.system.txt` | The same command, system-wide, without command names. |
| `tmux-panes.<tag>.txt` | `tmux list-panes -a -F '#{session_name} #{pane_pid}'`, run with the app's bundled tmux. |
| `probe.<tag>.json` | Status and content-type of `GET /` on each listener the subtree owns. |
| `axtree.<page>.json` | `Accessibility.getFullAXTree` from system Chrome, headless, with a scratch profile. |
| `cdp-events.<page>.jsonl` | Raw Runtime, Log, Network and Page events captured while that page loaded. |
| `dom-geometry.<page>.json` | `DOM.getContentQuads`, `DOM.getBoxModel` and `DOM.describeNode` for the page's first actionable nodes. |

## Shapes these recordings surfaced

None of these were in the plan. Each one changed a rule in `core/lanePorts.ts`:

1. **Agent-started dev servers are descendants of the agent.** The chain is
   `claude → zsh → npm exec vite → node` (ports 4173 and 5292).
2. **Every Claude and Codex session has a `mitmdump` proxy that answers
   `502 text/html`.** It is a sibling of the agent, not a descendant. A probe
   that only checks for HTML would still have counted it, so 5xx responses
   never count as a page.
3. **OpenCode's own server answers `200 text/html`.** It is the session's
   root process, so the attribution rule excludes listeners held by the root
   process itself.
4. **A real Vite dev server answered `404` on `/`** because it uses a custom
   config/base. A 404 at the root is therefore listed as `other`, not
   dropped.
5. **tmux terminal processes do not descend from Electron.** The tmux server
   daemonizes (its parent is PID 1) and is shared by both app instances on
   the default socket. The tmux process under Electron is only a client. A
   terminal's roots must therefore come from `list-panes`, filtered by the
   session's `tmuxName`. Example: `acpocket-rec-*` has pane 80307 (Python),
   whose parent is the tmux server.
6. **Electron main itself listens on several ports**, including the MCP host
   and one `200 text/html`. Attribution must never walk up to ancestors.
