# Repeated workspace save failures must reach the user (#1244)

## Verified failure
`useAutoSave` handled every rejected `window.api.saveWorkspace` with `console.warn` and an exponential-backoff retry, and nothing else. `WorkspaceFileStore` rethrows real I/O errors (ENOSPC, EACCES, rename). With a full disk or a permission change, every save failed forever while the user kept working, and the changes were lost at quit. The comment in `main/ipc/workspace.ts` claimed the renderer "surfaces" these failures; it only retried.

## Design
- **When to report:** after `SAVE_FAILURE_BANNER_AFTER` (3) consecutive failures, `useAutoSave` reports the storage error; the first success clears it. One failure is often transient and the retry fixes it silently.
- **What it says:** the error itself, stripped of Electron's IPC wrapper ("Error invoking remote method 'workspace:save': …"), which names a channel rather than the problem.
- **Where:** a `saveFailure` field on the workspace, beside `restoreStatus`. `RestoreBanner` shows "Workspace changes are not being saved: <error> …", after any restore problem, which is the more severe state. The collapsed chip reads "Not saving", not "Autosave off": saves are still attempted.

## Tests
- A genuine EACCES from a real write into a read-only directory, wrapped as IPC delivers it. No report before the third failure; then the stripped error; cleared on success.
- Banner render cases, including restore precedence.
- Every change is mutation-checked.
