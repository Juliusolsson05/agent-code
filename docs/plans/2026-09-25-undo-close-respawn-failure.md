# A failed Undo Close must say why (#1242)

## Verified failure
In `workspace/hook/actions/undoClose.ts`:
- `respawn` caught every spawn error with `catch { return null }`;
- `restoreSessionEntry` / `restoreTabEntry` turned that into `retryable-failure`;
- `undoClose` pushed the entry back and returned.

Nothing was shown. After a provider CLI broke, every Cmd+Shift+T silently did nothing. A group that restored only some members pushed the rest back silently too.

## Design
- **Keep the entry** on the stack (correct: the provider, not the entry, is broken).
- **Keep the spawn error** in a per-undo ref; it is reset at the start of each undo, so an older reason is never reused.
- **Toast the reason:** `Could not restore "<title>": <spawn error>` (or project "<title>", or "N closed items") through the global toast, for both a whole failure and a partial group.

## Tests
- A renderer test with the recorded `posix_spawnp failed` IPC rejection: the toast text is exact, and the entry stays on the stack.
- A partial group names the member that failed.
- Red on main; each branch is mutation-checked.
