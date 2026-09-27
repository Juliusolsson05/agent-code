# Renderer tests on Node 25: a working DOM Storage (#1212)

**Reproduced** with `/opt/homebrew/bin/node` v25.5.0: `recentCommandHistory.renderer.test.ts` fails with `window.localStorage.clear is not a function` and a read of `undefined`. Node warns "`--localstorage-file` was provided without a valid path".

**Cause.** Node 25 enables Web Storage by default. Without `--localstorage-file` its `globalThis.localStorage` is a half-initialised placeholder. Because the global already exists, Vitest's happy-dom environment leaves it in place, so renderer code talks to Node's broken storage instead of the DOM's.

**Fix.** `testing/setup/storage.ts` `installWorkingStorage()` is called from the renderer setup file. It puts a happy-dom `Storage` on `localStorage` / `sessionStorage` wherever the existing one has no `clear`. On Node 22/24 it is a no-op.

**Tests.**
- `testing/unit/setupStorage.test.ts` pins the repair against a stand-in with Node 25's shape, because CI runs Node 24.
- `src/renderer/src/app/storageEnvironment.renderer.test.ts` checks that the renderer environment's storage works.
- Verified on Node 25.5.0 and 24.14.1. Without the fix, the storage-using renderer tests fail 1 of 4 files on Node 25.

**Out of scope.** Any other Node 25 incompatibility in the full suite; this issue is the storage setup.
