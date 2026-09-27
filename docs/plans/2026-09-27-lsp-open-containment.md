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

**Residual.** The window between the re-check and `didOpen` is one await, which is inherent to any path-based open. The IPC wiring of the callback is not covered by a test (the handlers need Electron).
