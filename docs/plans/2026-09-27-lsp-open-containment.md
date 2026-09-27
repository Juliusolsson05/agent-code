# LSP open: re-check physical containment at the moment of use (#1268)

**Gap.** `authorizeContext` (`src/main/ipc/lsp.ts`) validates the physical target, then `LspManager.openDocumentNow` awaits server startup, which can take seconds on a cold spawn. Only after that does it build a lexical `file://` URI and send `didOpen`. If a directory on the path is swapped for a symlink to an outside directory during startup, the server is handed a URI that resolves outside the root.

**Fix.**
- **Manager:** `OpenDocumentParams.assertPhysicalTarget`, a callback from the authorizing caller. The manager awaits it inside the per-document queue, after server startup and immediately before a NEW server document's `didOpen`. A refusal fails open (returns false: no LSP for this document) and names nothing to the server.
- **IPC:** both open paths (`lsp:open-document`, `lsp:reopen-document`) pass `lspPhysicalTargetAssertion(context)`. It re-runs the same rule: `resolveInsideRoot` + `validateExistingTarget` (no symlink, canonical inside the root) + regular file + an unchanged relative location.
- **Why a callback and not a filesystem check in the manager:** the IPC layer owns authorization for both editor roots and AI Workspace entries, and the manager's unit tests run on fake roots.

**Tests.**
- **Real filesystem:** the reviewer's probe. Authorize `src/a.ts`, then swap `src` for a symlink to an outside directory: refused. A leaf that became a symlink: refused. An untouched file: passes. A virtual document: nothing to check.
- **Manager:**
  - the re-check runs after `initialized` and before `didOpen`;
  - a refusal returns false with no notification;
  - a pass opens normally.
- **Mutations killed:** no re-check in the manager; no physical validation in the assertion.

## After review a of #1412
- **Shared joins:** the re-check runs at the top of the queued step for EVERY open, including one that joins an existing shared document (another alias of the same file). Before, only a new document's `didOpen` was guarded, so a join after a swap sent `didChange` for the escaped URI.
- **Virtual documents:** they are named under `root/.agent-code-lsp`, so that directory must not be a symlink out of the root. They now get a re-check too.
- **No exact relative-path comparison:** a case-only rename on a case-insensitive filesystem still resolves inside the root, and refusing it only lost LSP. Containment plus a regular file is the property.

**Residuals.**
- **One await:** the window between the re-check and the notification is one await, inherent to any path-based open.
- **A swap after a document is already open** (a later `didChange`, or a document request, for a URI the server already holds) is not guarded. The server already has that URI, and no per-change path check stops it from reading the path later. This issue is the authorization-to-use window of an OPEN.
- **The IPC wiring** of the callback is not covered by a test, because the handlers need Electron.

## After review b (1cb8b3cf)
Every assertion first checks that the canonical root still resolves to itself (`assertRootUnchanged`). A pathless document's check used to return early when the virtual directory was missing, without checking the root. Review b's other findings are the path-based LSP limit; B6 (owner proxy) accepted this PR as narrowing the window, `Refs #1268`.

## After review c
- The virtual branch now checks the LEAF `didOpen` names (`virtual-<hash>.<ext>`, from `lspVirtualDocumentName`, shared with the manager). It must be absent, or a regular file inside the root. A leaf symlink created in advance escaped with no timing window. A pathless open without its leaf name is refused.
- The regular-file re-check is pinned: an authorized file that became a directory is refused.
- The IPC wiring of the callback still has no committed test. A wiring test is feasible with the existing Electron mock; it is left out under the freeze and stated as a residual.
