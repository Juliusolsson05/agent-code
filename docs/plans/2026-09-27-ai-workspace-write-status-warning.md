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
3. **A refused save explains itself.** `preserveOwedCopy` rewrites a copy failure: "AI Workspace storage needs attention: N unreadable row(s) must be copied aside before saving, and the copy could not be written (<code>). <advice for that code>" (the advice names the state file's folder) Only the errno code is kept, not the raw text.

## Tests (fail-first, `AiWorkspaceRegistry.test.ts`)
The input is the real recorded workspace state. One real entry is pointed at a temp file (the recorded paths are redacted), and one real workspace is made malformed so a copy is owed. The copy path is blocked with a directory.
- `writeFile` puts the new text on disk and returns `ok: true` with a status warning. The state file is unchanged. Red without the fix: `{ ok: false, error: 'is a directory' }`.
- A following `create` is refused with the actionable message.
- Mutations: dropping the warning, and misreporting the write as failed, each fail the first test.

## Review a (round 1)
- **The editor showed no warning.** It now keeps a separate `storageWarning`, set from the write result on both Save and Overwrite and cleared by the next write that has no warning. It is shown through the file list's existing alert (`error ?? storageWarning`). It cannot ride `error`, because `loadWorkspace` clears that after every save.
- **The warning is fixed text.** `AI_WORKSPACE_STATUS_NOT_SAVED` is main's own sentence; the raw cause goes only to the log.
- **A throwing `changed` listener no longer fails a landed write.** Each emit is guarded, so every other workspace still hears about the write.
- **Advice matches the cause.** An occupied copy path (EISDIR/EEXIST/ENOTDIR), a missing folder (ENOENT), a permission or read-only refusal, and a full disk each get their own advice.
- **Tests added:** the file reads back after the warning; an ordinary write carries no warning; a throwing listener still gives `ok: true`, and the listener is still called; ENOENT advice. The always-warn, unguarded-emit and wrong-advice mutations each fail.
- **Not tested:** the editor's display of the notice is not covered at the component level (there is no AiWorkspaceEditor renderer harness). The change there is three lines, and it is stated in the body.

## Review b (round 1)
- **The notice was lost on a workspace switch, and never shown if the switch happened mid-write.** The editor held it only in React state. It is now durable in main: `get` returns a runtime-only `storageWarning` (`AI_WORKSPACE_STORAGE_BLOCKED`) while a copy is owed and its last attempt failed. The flag is set when the copy fails and cleared when it succeeds, and it is never persisted. `loadWorkspace` sets the editor's notice from it on every load, so a remount shows it again. The write-result warning still sets it immediately.
- **Wrong advice for ENOTDIR and EROFS.** ENOTDIR now gets the generic advice, since it means a component of the folder path is a file. EROFS gets its own read-only-volume advice.
- **Surviving mutations, now killed:**
  - appending the raw error text to the refusal (asserted absent);
  - stopping the fan-out after the first workspace (two-workspace test);
  - dropping `get`'s notice.

## Review c (at 589d42a9; MERGE-READY)
Test-strength notes, not defects:
- The emit on the warning path and the fan-out are now pinned. The two-workspace listener test landed in `d8f1eae6`.
- Four of the six advice branches (EACCES/EPERM, EROFS, ENOSPC, generic) have no test. They are not reachable portably from a unit test without mocking the filesystem module.
- The quoted refusal sentence in this plan and the body is corrected to the code's wording, and a test title is fixed.
