# orchestration-api-error fixtures (#1018)

These are cleaned-up excerpts of real recordings. They show what the renderer
session runtime sees around provider API errors: the event order, the runtime
fields, the timings, and the provider's own record of the same failure. The
analysis and the proposed failure rule are in `CATALOG.md`.

## File layout

Every fixture is a single JSON object. It contains:

- `fixture`, `provider`, `providerRuntime`, and a one-line `outcome`.
- `provenance`: the source file, session id and recording time. Paths use the
  placeholders listed under "Cleaning rules" below.
- `feedDebug.events[]`: feed-debug rows, in the order they happened:
  `{tMs, layer, kind, summary, data?, repeats?, lastTMs?}`.
  - `tMs` counts milliseconds from the first row of the excerpt. The absolute
    anchor is `feedDebug.anchorEpochMs` / `anchorIso`.
  - When `process_state` rows repeat with the same summary back to back (the
    providers re-emit activity once a second), they are collapsed into one row.
    `repeats` is the count and `lastTMs` is the time of the last copy. Every
    change of state keeps its own row and time.
  - RENDER rows are reduced to `{streamPhase, workRows, providerNotices, rowCount}`
    and kept only when one of those values changes.
  - SEM rows carry only `{eventType}`. That is all the production feed-debug
    log records unless `AGENT_CODE_DEV_DEBUG` raw capture is on.
- Provider-side evidence for the same failure. Depending on the fixture this is
  `opencodeDbAssistantRow(s)`, `proxyWire`, `rolloutTurnEvents`, or
  `*_committedEntries`.
- `derived*` blocks: what our code turns the recorded input into, such as the
  semantic `api_error` payload. These blocks are **not recorded**. Each one names
  the code path that produces it.

## Fixtures and provenance

| File | What it shows | Sources (on the dev machine) | Session id(s) | Recorded (UTC) |
|---|---|---|---|---|
| `opencode-structured-usage-limit-terminal.json` | The #1018 bug itself. A structured-runtime OpenCode child gets a zai 429 usage limit and retries 5 times. Then `api_error` → idle → `turn_completed`, and nothing more. The parent's `wait_agents` still reports `prompt_sent`/`waiting`. | `~/.config/agent-code/feed-debug/27402108-4c7e-4b88-b94b-a8b5b5f3199b.jsonl`; `~/.local/share/opencode/opencode.db` message `msg_0b8035dbc…` (session `ses_f47fca71…`); parent tool results in `~/.claude/projects/<agent-code>/83a02301-2e9a-42a6-98cb-38cffc008e25.jsonl` | Agent Code `27402108-4c7e-4b88-b94b-a8b5b5f3199b` (5 siblings with the same failure: `d5110ac0`, `1c4e3e0e`, `8ea852b7`, `c8dda0c8`, `8aa4fcc3`); parent `44cc62fa-63f9-46ad-9d6a-f96448813018`, run `release-pr-review` | 2026-09-19 04:53:38 – 04:56:34 |
| `opencode-terminal-usage-limit-after-retries.json` | OpenCode Terminal runtime. `retrying (attempt 1..5)` while `processActive=true`, then `api_error` with the real message ("The usage limit has been reached", openai/gpt-5.6-sol), then idle. | `feed-debug/9cd8d6c6-0a1b-46d6-a4b9-e96b83b62057.jsonl`; OpenCode DB session `ses_d7a1e644…` | `9cd8d6c6-0a1b-46d6-a4b9-e96b83b62057` | 2026-09-17 20:41:13 – 20:42:31 |
| `opencode-terminal-nonretryable-and-abort.json` | Three kinds of OpenCode `api_error` that come without retries. (a) 403 `isRetryable:false` ("OpenCode's free tier can only be used from within OpenCode"). (b) `MessageAbortedError` "Aborted" from a user interrupt: the same `api_error` kind. (c) A 403, then the **user** sends a new prompt 8.5 s later and that turn runs normally. | (a) `feed-debug/eb8287fc-7626-4f3a-b30d-cddeb84aad45.jsonl` + DB `ses_9848b97f…`; (b) `feed-debug/6d6cac8c-fe3d-4f5e-82e3-740036b4aebd.jsonl` + DB `ses_7e76f124…`; (c) `feed-debug/2c690b9e-d218-4543-984d-02c268a043ca.jsonl` | `eb8287fc…`, `6d6cac8c…`, `2c690b9e…` | (a) 2026-09-17 20:41; (b) 2026-09-18 00:20; (c) 2026-09-18 00:07 |
| `codex-usage-limit-terminal.json` | Codex. The proxy gets HTTP 429 `usage_limit_reached` 0.3 s into the turn, with no retry. `api_error` → rollout `turn_completed` → screen idle 2.4 s later. Includes the decoded wire, the derived semantic event, the rollout `task_complete.error`, and a visible sibling pane that shows the provider notice. | `feed-debug/822500c6-d223-4ceb-b3cd-ebdad9726972.jsonl`; `~/.config/agent-code/proxy/<project>/shell-822500c6…/2026-09-18T21-11-55-475Z/proxy-events.jsonl` (req-4); `~/.codex/sessions/2026/09/18/rollout-2026-09-18T14-12-02-01a0b65c-ac48-….jsonl`; sibling `feed-debug/c214f5c1-3fe4-4139-9567-89ba5c657932.jsonl` | `822500c6-d223-4ceb-b3cd-ebdad9726972`, `c214f5c1-3fe4-4139-9567-89ba5c657932` | 2026-09-18 21:11:55 – 21:12:10; sibling 2026-09-19 02:12:19 |
| `claude-usage-limit-terminal.json` | Claude. There is **no** semantic `api_error`. The only signal is a committed synthetic assistant entry (`isApiErrorMessage`, `error:'rate_limit'`, `apiErrorStatus:429`), usually followed by `system/turn_duration`. (a) With an app-composer submit, `streamPhase` stays `'submitting'` for more than 170 s. (b) With a prompt typed in the TUI, the phase stays idle. | (a) `feed-debug/1a57da1e-23fb-459f-a491-45e1cd56ae75.jsonl` + transcript `~/.claude/projects/<agent-code>/8b8e3715-53f3-42c9-8f7a-49681e1d1e5a.jsonl`; (b) `feed-debug/361ef0c4-800b-4bb5-85f4-931183e8583c.jsonl` + transcript `…/61a7daed-9765-40ac-adab-b20c428c8afd.jsonl`; extra shape from `~/.claude/projects/<startup>/114171fa-a156-4ae6-96aa-54550170cd35.jsonl` | `1a57da1e-23fb-459f-a491-45e1cd56ae75`, `361ef0c4-800b-4bb5-85f4-931183e8583c` | (a) 2026-09-19 01:06:50 – 01:09:46; (b) 2026-09-17 23:27:15 – 23:27:31 |
| `opencode-terminal-retry-in-flight.json` | An OpenCode retry in progress, which is **not** a final failure: `retrying (attempt 1..5)` for about 70 s with `processActive=true` and no `api_error`. The turn then ended with no `session.error`; the DB row has `time.completed` set, no error, no finish and 0 tokens, which suggests an external stop. **This corpus has no recording of a retry that later succeeded.** | `feed-debug/53330d96-5c65-4e55-a385-d8f8b3a3d267.jsonl`; DB message `msg_0b7ffafa2…` (session `ses_73d5e74b…`) | `53330d96-5c65-4e55-a385-d8f8b3a3d267` (sibling with the same stop: `2aee6636-6370-46f8-ba96-7eb736a925a9`) | 2026-09-19 04:49:40 – 04:50:53 |

Tool versions at recording time: OpenCode binary 1.18.31
(`~/.opencode/bin/opencode --version`), Codex CLI 0.155.1 (proxy `user-agent`),
Claude CLI 2.1.278 (proxy `user-agent`).

## Cleaning rules

The generator was a one-off script, deliberately not committed, and it read the
sources read-only.

- Paths: `$HOME/Desktop/Development/agent-code` → `<REPO>`. Worktree paths →
  `<REPO>/.worktrees/<worktree>`. Other development folders → `<DEV>`. `$HOME` →
  `<HOME>`. Claude project-directory names → `<claude-project-dir>`.
- Prompt and answer text is cut to a recognisable 48-character prefix. Provider
  error text is kept word for word, because it is what we would report.
- OpenCode `responseHeaders` are reduced to `date`, `retry-after` and
  `retry-after-ms`. Trace ids, request ids and cookies are removed.
- `provider_session_observed` rows no longer carry provider session ids.
- Proxy excerpts keep only the one failing request (`req-4`): its status line,
  the `x-codex-*` rate-limit headers, and the decoded body. Request bodies and
  authentication headers are never read into the fixtures.
- No e-mail addresses, tokens, or organisation ids appear anywhere. A grep for
  `/Users/`, the user name, `bearer`, `cookie` and `traceid` came back empty.
