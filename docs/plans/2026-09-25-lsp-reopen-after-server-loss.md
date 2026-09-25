# An open editor regains LSP after its server is lost (#1208)

## Verified failure
- `LspManager.discardServer` (on a crash, or on retirement for ignoring cancelled requests, #924) deletes every document of that server generation.
- The IPC layer (`src/main/ipc/lsp.ts`) keeps its ownership and per-owner reference counts, and `lsp:change-document` rejects `LSP document is not open` (#922).
- The renderer's sync gate (`syncEditorLspModel`) swallows that rejection. The editor has no hover, completion or diagnostics until it is remounted, and nothing tells the user.

The #922 test in `lspDocumentOrdering.test.ts` already reproduces the loss through the real IPC handlers.

## Why the first fix was withdrawn (from the issue)
A main-side re-open using authorization cached at first open:
- let a capability outlive its owner;
- skipped the physical-target checks (a symlink swapped in after the first open escaped the root);
- restored one reference of two.

## Design: renderer-driven, main-authorized
**New `lsp:reopen-document`** (same params as open). It:
- is accepted only from the renderer that currently owns the URI (`isOwned`); another renderer is refused;
- runs inside the URI's existing IPC queue, the same entry discipline as open and close;
- is a no-op when the manager still has the document, so there is never a double count;
- re-authorizes with the caller's CURRENT authorization through `authorizeContext`, including `validateExistingTarget` and the regular-file check; nothing cached is reused;
- re-checks ownership after the await: if the owner was cleared meanwhile (destroyed, navigated, or finally closed), nothing is opened, and the closes that `clear()` queued balance anything in flight;
- restores the manager's reference count to the owner's IPC count for that URI (two mounts give two refs), rolling back if any open fails.

**Renderer:**
- A mount registers a `reopen` callback with its own current LSP context. `syncEditorLspModel`, on a `not open` rejection, calls it once per URI.
- On success the change is re-sent.
- Retries are throttled with an expiring backoff (5 s doubling to 60 s, reset by success), so a server that dies on startup is not respawned per keystroke.

## Tests (fail-first, real IPC handlers, the fake connection as the only stub)
- **Two mounts:** discard, reopen, both references restored (closing one keeps LSP for the other).
- **Ownership:** a non-owner is refused, and failed current authorization opens nothing.
- **Symlink:** a real temp root, `src` replaced by a symlink outside the root after the first open; reopen is refused.
- **Owner cleared** during a paused authorization: nothing reopened.
- **Not lost:** reopen is a no-op, with no extra reference.
- **Renderer:** reopen on `not open`, throttled within the window, retried after it expires, backoff reset on success.
