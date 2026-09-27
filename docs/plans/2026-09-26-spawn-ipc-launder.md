# session:spawn stops relaying raw provider exceptions over IPC (#1267)

## Evidence
- `src/main/ipc/session.ts` rethrew whatever `manager.spawn` threw. IPC relays the message, so the recorded posix_spawnp rejection (`testing/fixtures/spawn-failure/posix-spawnp-2026-09-23.json`), plus any environment values, proxy URLs or scoped MCP tokens a launch exception carries, reached the renderer verbatim.
- `recover()` already flattens its failures to `SESSION_START_FAILED_MESSAGE` (sessionManager recoverSession).
- Each renderer surface had to remember not to show the text. #1286 made the renderer flatten it once, but the raw text still crossed IPC.

## Change
- The spawn handler launders its rejection (`launderSpawnError`). Only these cross as themselves:
  - a missing workspace folder (curated; a path the UI already shows);
  - a missing provider CLI (curated; names File › Setup…);
  - this window losing the session.
- A Claude proxy that would not start becomes its fixed guidance. That sentence and its detection move to shared, so main and renderer use one copy.
- Everything else becomes the safe sentence, and the raw error is logged in main.

## Tests
- `ipc/session.test.ts` "session:spawn rejections": the recorded fixture plus a token and credentialed URL is flattened; the curated failures and the window refusal pass; a mitmproxy failure becomes the guidance without its raw text.
- Red on main, and every branch is mutation-checked.
