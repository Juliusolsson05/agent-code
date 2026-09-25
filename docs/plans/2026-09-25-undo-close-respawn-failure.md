# A failed Undo Close must say why (#1242)

## Verified failure
In `workspace/hook/actions/undoClose.ts`:
- `respawn` caught every spawn error with `catch { return null }`;
- `restoreSessionEntry` / `restoreTabEntry` turned that into `retryable-failure`;
- `undoClose` pushed the entry back and returned.

Nothing was shown. After a provider CLI broke, every Cmd+Shift+T silently did nothing. A group that restored only some members pushed the rest back silently too.

## Design
- **Keep the entry** on the stack (correct: the provider, not the entry, is broken).
- **Toast a safe sentence** (steering q22): `Could not restore "<title>": Session failed to start. Check provider setup and retry.` (or project "<title>", or "N closed items"), through the global toast, for both a whole failure and a partial group. The spawn's own text is never shown: it is the raw provider exception relayed through IPC and can carry environment values or tokens, so it gets the shared `SESSION_START_FAILED_MESSAGE` that main's recovery and the reload path use.

## Tests
- A renderer test with the recorded `posix_spawnp failed` IPC rejection: the toast text is exact, and the entry stays on the stack.
- A partial group names the member that failed.
- Red on main; each branch is mutation-checked.
