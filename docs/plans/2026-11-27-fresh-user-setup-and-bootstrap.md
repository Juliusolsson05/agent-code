# Plan: Fresh-User Setup, Binary Detection, and Bootstrap Fixes

Fixes #1553

## Problem

Fresh-user setup, binary detection, and provider enablement have several interlocking bugs that strand or mislead users who start with zero providers, have noisy shell startup files, or run into Gatekeeper/noexec stalls on bundled tools:

1. **Stale `providerEnablement` cache after Setup discovers a CLI**: `providerEnablement.ts` caches `cachedDetected` for the process lifetime and only clears it on `resetProviderEnablement`. When a user installs a CLI or sets a manual path in `SetupGate` (`setup:check` / `setup:set-tool-path`), `provider-enablement:changed` is never broadcast, so `PathPickerModal` (`⌘T`) still hides the newly installed provider until app restart.
2. **0-provider `PathPickerModal` silently submits Claude**: When a user chooses "Continue with a Terminal" (`enabledKinds.size === 0`), `PathPickerModal` renders an empty provider bar and silently falls back to `DEFAULT_PROVIDER` (`'claude'`), causing `⌘T` to fail on spawn instead of offering to open Setup or a Terminal tab.
3. **Unbounded `probeExecutable` and sticky failed-probe cache**: In `runtimeTools.ts`, `probeExecutable` has no timeout (a Gatekeeper/XProtect stall hangs indefinitely) and caches rejected promises permanently in `execProbeCache` (clearing quarantine and clicking Retry still fails until app restart).
4. **Bundled archive presence vs. executable resolution mismatch**: `prerequisites.ts` marks bundled tools (`opencode`, `mitmdump`) as `found: true, source: 'bundled'` using `isBundledArchiveAvailable` (file existence only) instead of `resolveBundledTool` (actual extraction + exec probe), and ignores a valid manual override on a bundled tool. When the bundled binary fails its exec probe, `SetupGate` falsely reports "Bundled" and hides manual override / install options.
5. **`SetupGate` UX dead ends**:
   - Pressing `Enter` inside "Enter Path Manually…" bubbles to `DialogActions` and closes `SetupGate` before the user sees the result or validation error.
   - `setup:set-tool-path` rejects `~/...` paths instead of expanding leading `~/` to `homedir()`.
   - `Found` (and `Bundled`) provider rows do not offer **Change Path…**, so users cannot point an already-detected provider at a different binary.
   - When `setup:check` fails (`check === null`) and the user explicitly opens Setup (`requested && error`), `SetupGate` returns `null` instead of rendering the error state with a Retry button.
6. **Noisy `.zprofile`, missing macOS bin dirs, and duplicate startup probes**:
   - `binaryResolver.ts` reads the *first* line of `zsh -lc` stdout, so any `.zprofile` banner/echo breaks `command -v` detection for every tool.
   - `WELL_KNOWN_BIN_DIRS` omits `~/.local/share/mise/shims`, `~/Library/pnpm`, `~/.npm-global/bin`, and `~/.claude/local`.
   - `checkPrerequisites()` does not deduplicate concurrent in-flight calls, so startup (`SetupGate` + `providerEnablement`) spawns ~16 parallel login shells at once.

## Implementation Plan

1. **`providerEnablement` sync + 0-provider `PathPickerModal`**:
   - Add `syncDetectedProvidersFromCheck(result)` to `src/main/setup/providerEnablement.ts` that updates `cachedDetected` / `lastDetected`, re-resolves the snapshot in order, invalidates the usage cache, and broadcasts `provider-enablement:changed` when detected providers change (or on initial sync).
   - Call `syncDetectedProvidersFromCheck` from `setup:check` and `setup:set-tool-path` in `src/main/ipc/setup.ts` (best-effort so a sync error never fails setup IPC).
   - Update `PathPickerModal.tsx` and `PathPickerSurface.tsx` so when `enabledKinds.size === 0`:
     - Show an inline notice with an **Open Setup** action.
     - Skip conversation listing and hide `ResumeSection`.
     - Offer **Open Terminal** / **Create & Open Terminal** (via `onOpenTerminal`) instead of silently submitting `DEFAULT_PROVIDER`.
     - Sync `provider` when `enabledKinds` changes from empty to non-empty.
2. **Bounded `probeExecutable` timeout & success-only caching (`src/main/setup/runtimeTools.ts`)**:
   - Add an 8s default timeout (`EXEC_PROBE_TIMEOUT_MS`) to `probeExecutable` that kills the hung child (`SIGKILL`) and rejects with `BundledToolExecProbeError`.
   - Keep in-flight deduplication in `execProbeCache`, but evict rejected entries on failure so Retry re-probes cleanly.
3. **Align bundled tool detection with `resolveBundledTool` (`src/main/setup/prerequisites.ts`)**:
   - For bundled tools without a valid manual override, call `resolveBundledTool(tool)` instead of `isBundledArchiveAvailable(tool)`.
   - Only report `source: 'bundled'` when `resolveBundledTool` returns a non-null executable path; otherwise fall back to system PATH / manual override / install prompt.
   - Respect valid manual overrides over bundled tools (matching `toolchain.ts`).
4. **Fix `SetupGate` UX dead ends (`SetupGate.tsx`, `dialog-actions.tsx`, `src/main/ipc/setup.ts`)**:
   - Support `data-owns-enter` in `focusedControlOwnsEnter` (`dialog-actions.tsx`), mark the manual path `<Input>` with `data-owns-enter`, and disable `confirmOnEnter` on `SetupGate`'s `DialogActions` while any row's path editor is open.
   - Expand leading `~/` (and bare `~`) to `homedir()` in `setup:set-tool-path` before absolute-path validation.
   - Enable manual path editing on all provider rows (**Change Path…** when found/bundled, **Enter Path Manually…** when missing).
   - Render `SetupGate` when `requested && error` even when `check === null`, showing the error alert, Close, and Retry.
5. **Fix `binaryResolver.ts` & deduplicate `checkPrerequisites()`**:
   - Read the last non-empty line of `runLoginShell` stdout in `resolveToolPath` so `.zprofile` banners do not break detection.
   - Add `~/.local/share/mise/shims`, `~/Library/pnpm`, `~/.npm-global/bin`, and `~/.claude/local` to `WELL_KNOWN_BIN_DIRS`.
   - Deduplicate concurrent in-flight `checkPrerequisites()` calls via an `inFlightCheck` promise cleared in `.finally()`.

## Verification

- Add/update unit & renderer tests in:
  - `src/main/setup/providerEnablement.test.ts`
  - `src/main/ipc/setup.test.ts`
  - `src/main/setup/runtimeTools.test.ts`
  - `src/main/setup/prerequisites.test.ts`
  - `src/main/setup/binaryResolver.test.ts`
  - `src/renderer/src/components/ui/dialog-actions.renderer.test.tsx`
  - `src/renderer/src/features/setup/firstRun.renderer.test.tsx`
  - `src/renderer/src/features/path-picker/ui/PathPickerModal.renderer.test.tsx`
- Run `npm run typecheck` and targeted `vitest` suites in the worktree.
