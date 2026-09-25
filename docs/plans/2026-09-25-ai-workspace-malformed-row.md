# One malformed AI Workspace row must not fail every operation (#1246)

## Verified failure
In a registry built from the owner's real `ai-workspaces.json` (13 workspaces; fixture redacted), each of these made `list()` reject:
- an entry with a non-string `path` (`resolve()` throws);
- a workspace with a non-string `updatedAt` (`localeCompare`);
- an entry with a `null` status (`status.exists`).

The rejected load was cached (`??=`), so every operation failed for the rest of the process. An unreadable file is cached the same way.

## Design
- **Bad workspace or entry:** validated per row and set aside for itself.
- **Status-only damage:** an entry whose only damage is its cached status keeps a status of "unknown". Statuses are a refreshable cache, not user data.
- **Preserved bytes:** before the next save can drop a set-aside row, the file's bytes are kept at `<file>.invalid-<digest>.json`, using the new shared `src/main/storage/preserveInvalidBytes.ts` (atomic, verified, idempotent).
- **Malformed container:** still refuses, and the file stays untouched.
- **No cached failure:** a failed load is no longer cached.

## Tests
Real rows with those three damages, status repair, container refusal, and failed-load un-caching. Red on main; the five mutants all fail.
