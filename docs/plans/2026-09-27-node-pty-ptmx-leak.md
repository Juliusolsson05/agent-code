# Stop leaking one /dev/ptmx per spawn on macOS (#1437)

Size: short plan. The root cause is known and verified below; the fix is a
port of an upstream patch.

## Outcome

Spawning an agent or terminal no longer leaks a PTY master in the main
process. Open `/dev/ptmx` fds in main track live sessions, so a long-running
app never reaches `kern.tty.ptmx_max` (511) and never fails every spawn with
"posix_spawnp failed".

## Evidence (verified 2026-09-27, do not re-derive)

- Packaged app, main pid 94543, uptime ~13.5 h: `lsof -p` shows **506**
  `/dev/ptmx` fds (major 15). Only **16** slave fds (`/dev/ttysNNN`, major
  16) are open in main, and those 16 are exactly the ttys that still have a
  process (`ps -axo tty`). So ~490 masters belong to no live session.
- The packaged app ships node-pty **1.1.0** (`app.asar.unpacked`), the same as
  the repo's `node_modules/node-pty` (`lib/unixTerminal.js` is identical).
  1.1.0 is still npm `latest`.
- node-pty 1.1.0 `src/unix/pty.cc` `pty_posix_spawn` (macOS only):
  `low_fds[count] = posix_openpt(...)` breaks at `count == 0` whenever stdio
  is open (always, in Electron). The cleanup
  `for (; count > 0; count--) close(low_fds[count]);` never closes
  `low_fds[0]`. **Every spawn leaks one ptmx.** It has no slave and no
  process, which matches the ~490 orphans exactly.
- Upstream: microsoft/node-pty#882 "fix: /dev/ptmx leak on macOS" (merged
  2026-01-28, `af053f22`, for microsoft/vscode#182212). The same diagnosis:
  "The ptmx leak was from `low_fds[0]` that was always opened and never
  closed." It shipped in 1.2.0-beta.10 and later. There is no stable release
  with it.
- The same function also never closes the parent's copy of the **slave** fd,
  and every early-error `return` leaks the master (and slave). The error
  path then reports the generic "posix_spawnp failed." with `err == -1`.
  #882 fixes all three.
- node-pty is compiled from source during `postinstall`
  (`electron-rebuild -f -w node-pty`), and electron-builder rebuilds it per
  target arch (`electron-builder.yml`: prebuilds excluded, npmRebuild on).
  `lib/utils.js` loads `build/Release` before `prebuilds/`. So a source
  patch applied before the rebuild is what ships.

## Decision

- **Ruling:** use a local source patch of 1.1.0 (`scripts/patch-node-pty.mjs`,
  run from `postinstall` before `electron-rebuild`), not a bump to
  1.2.0-beta.15. The beta line brings unrelated ConPTY and API churn into
  every platform; the patch is one function, already reviewed upstream. This
  is the same shape as `scripts/patch-xterm.mjs` (#871). **Cost if wrong:** we
  carry a patch until node-pty publishes a stable release with #882; the
  script fails loudly on any other version.
- Pin `node-pty` to exactly `1.1.0` (currently `^1.0.0`), so the patch
  anchors cannot silently drift under a lockfile refresh.

## Change

1. `scripts/patch-node-pty.mjs` rewrites `node_modules/node-pty/src/unix/pty.cc`
   `pty_posix_spawn` to #882's shape:
   - close every opened `low_fds[i]` for `i <= count`;
   - close the parent's `slave` after spawn;
   - `goto done` on every early error, which also destroys the
     `posix_spawn` file actions and attrs;
   - `PtyFork` closes `master` on failure and throws the specific failing
     call with its `strerror`.
   It is idempotent (a marker comment) and verifies its anchors. It **fails
   the install** if node-pty is not 1.1.0 or an anchor is missing, with a
   WHEN THIS FAILS note: check whether upstream now ships #882 and drop the
   patch.
2. `package.json`: `postinstall` runs `node scripts/patch-node-pty.mjs`
   before `electron-rebuild`; `node-pty` is pinned to `1.1.0`; the lockfile is
   resynced.

## Tests

- `testing/unit/patchNodePty.test.ts` runs against the real 1.1.0 `pty.cc`,
  committed byte-exact under `testing/fixtures/node-pty-1.1.0/` (with the
  package's LICENSE and a `-text` gitattribute). After postinstall, the
  `node_modules` copy is the patched one, so it cannot serve as the input. It checks that
  the patched output closes `low_fds[0]` and `slave`; that a second run is a
  no-op; and that a wrong version or a missing anchor throws. It fails before
  the fix because the script does not exist.
- `testing/system/nodePtyPtmxLeak.test.ts` (fd-leak regression) ports #882's
  own test. It spawns 20
  `/bin/sh -c true` PTYs through node-pty, one at a time, and asserts that
  main's `/dev/ptmx` count (via `lsof -p`) does not grow. It is darwin only.
  Pre-fix it must fail by ~20. **Gated:** it needs free PTYs, and q117
  forbids new probes until B6 restores capacity. It runs once capacity is
  back.

## Verification

- `npx tsc -b`, the scoped vitest run, and the patch applied to an isolated
  `node_modules` copy with node-pty rebuilt there. The shared `node_modules`
  is never rebuilt, because other workers' worktrees symlink to it.
- **Boundary:** the packaged app is not rebuilt or run here (never launch the
  app). After merge, the check is `lsof -p <main> | grep -c ptmx`, which
  should stay near the live session count after closing and reopening
  agents.

## Out of scope

- Workaround for the current machine: an app restart frees all masters.
  That is the owner's call.
- node-pty's unrelated `spawn_helper` title tweak in #882 (`unixTerminal.ts`).
- `packages/claude-code-headless/node_modules/node-pty` (a dev copy, not
  shipped).

## Execution notes

- Ruling: tests live in `testing/unit` and `testing/system`, not
  `scripts/`. Vitest collects neither `scripts/**`, and
  `verifySubmoduleCheckouts.test.ts` already tests a `scripts/*.mjs` this
  way. Cost if wrong: none; this is placement only.
- Ruling: the cleanup loop is bounded by `i < 3`, a deliberate difference
  from #882. #882's `i <= count` reads `low_fds[3]` when all three opens
  land below fd 2. Cost if wrong: none; the bound only removes an
  out-of-bounds read.
- Ruling: the thrown message keeps the `posix_spawnp failed` prefix and adds
  the cause. #882 throws the cause alone. The prefix is LOAD-BEARING:
  `src/main/ipc/session.ts` `classifySpawnFailure` keys the `posix-spawnp`
  signature on it (#1324). The first version of this note said nothing
  matched on the text, which was wrong (#1439 review c). The classifier's
  test now pins the patched message shape.
- Verified: the patched source compiles with node-gyp against Node 24, in
  an isolated copy under the scratchpad. The only warnings are two
  pre-existing ones (1.1.0's kqueue initialisers), and the shared
  `node_modules` was untouched. Unit test 7/7. Restoring the countdown
  loop turns 2 tests red.
- System test, run after the q117 pause lifted:
  - it FAILS on the shared, unpatched build (`expected 20 to be less than or
    equal to 0`), one leaked master per spawn;
  - an isolated copy patched by the script and rebuilt with node-gyp gives
    0 → 0.
  - Reviewers a and b reproduced both numbers independently.
- Review round 1 (a, b MERGE-READY with minors), both fixed fail-first:
  - a: the unit test now pins the DIRECTION of the `low_fds[i] != -1`
    guard and of the final `spawn_err != 0` check. Each inversion, even
    with `PATCHED_SHA256` updated to match, turns a test red. Linux CI
    never runs the macOS fd test, so this is the CI-side pin.
  - b: the CLI entry compares real paths, so a run through a symlinked
    path patches instead of silently exiting 0. It is pinned by running the
    real script through a symlinked directory.
