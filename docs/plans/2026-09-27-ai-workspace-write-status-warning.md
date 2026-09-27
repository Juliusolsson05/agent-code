# An AI Workspace write whose status save fails is reported as done (#1285)

## Problem
`AiWorkspaceRegistry.writeFile` first replaces the user's file on disk (`atomicWriteTextFile`), then refreshes the entry status. The refresh saves registry state, and a save must first make any preservation copy it owes (#1260: rows the load could not read are copied aside before a save drops them).
- **When the copy is blocked** (for example, a directory sits on `ai-workspaces.json.invalid-<digest>.json`), the save throws. `writeFile` then returned `{ ok: false, error: "is a directory" }` although the file was written.
- **What that caused.** An agent or the editor told "failed" retries (converging through the version conflict) or reports a failure that did not happen.
- **Cosmetic.** Refused saves relayed the raw errno text, with no hint that clearing the copy path unblocks them.

## Evidence
- **The sequence** was reproduced and confirmed by #1260 review B (round 2), and recorded as residual #1285 (steering q24). The owed-copy state itself comes from the real registry file: `testing/fixtures/ai-workspace/real-workspaces-2026-09-25.json`, two real workspaces from the owner's `ai-workspaces.json`. The existing #1260 tests make that state owe a copy by marking one real workspace malformed, and block the copy with a directory.
- **The only consumer** of the write result is the renderer editor over IPC (`src/main/ipc/aiWorkspace.ts` → `AiWorkspaceEditor.tsx`). There is no MCP tool on this path.

## Decisions (defaults)
1. **A failed status refresh after a successful write does not fail the write.** It returns `ok: true` with an optional `warning` on the success branch of `AiWorkspaceWriteFileResult`, documented as "the file IS written; do not retry". It logs the error, and still emits `file-written` to every workspace holding the file.
2. **The owed-copy invariant is unchanged.** The state file is still never saved while a copy is owed.
3. **A refused save explains itself.** `preserveOwedCopy` rewrites a copy failure: "AI Workspace storage needs attention: N unreadable row(s) must be copied aside before saving, and the copy next to <state file> could not be written (<code>). Clear whatever occupies that copy path to continue." Only the errno code is kept, not the raw text.

## Tests (fail-first, `AiWorkspaceRegistry.test.ts`)
The input is the real recorded workspace state. One real entry is pointed at a temp file (the recorded paths are redacted), and one real workspace is made malformed so a copy is owed. The copy path is blocked with a directory.
- `writeFile` puts the new text on disk and returns `ok: true` with a status warning. The state file is unchanged. Red without the fix: `{ ok: false, error: 'is a directory' }`.
- A following `create` is refused with the actionable message.
- Mutations: dropping the warning, and misreporting the write as failed, each fail the first test.
