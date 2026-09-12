#!/usr/bin/env node
// =============================================================================
// Local patch for @xterm/xterm — resize() must not flush the write queue.
// Runs from `postinstall` (package.json), before electron-rebuild. Issue #871.
// =============================================================================
//
// WHAT THIS DOES
//
// Removes ONE statement from `CoreTerminal.resize()` in both shipped bundles
// of the exactly-pinned `@xterm/xterm` beta (lib/xterm.mjs and lib/xterm.js):
//
//   resize(x, y) {
//     ...clamp x/y...
//     this._writeBuffer.flushSync();        // <- removed
//     this._bufferService.resize(x, y);
//   }
//
// That restores the resize semantics of stable @xterm/xterm 6.0.0, which this
// app ran on in production until #871 moved to the 6.1.0 beta line (the only
// line that contains the WebGL atlas fix, xterm.js #5883).
//
// WHY — THE UPSTREAM BUG
//
// Upstream commit bf7c95b6 ("Flush writes on resize", xterm.js PR #5599,
// 2026-01-09, first shipped in 6.1.0-beta.96, still on master as of
// 2026-09-11) made resize() call `WriteBuffer.flushSync()` to reduce race-
// related exceptions in VS Code's telemetry. flushSync drains with
// `while (chunk = this._writeBuffer.shift())`, which is wrong twice over:
//
// 1. It starts at index 0 and ignores `_bufferOffset`. The async writer
//    (`_innerWrite`) keeps chunks it has ALREADY APPLIED at the head of the
//    queue whenever it yields after its 12 ms budget with <= 50 applied chunks
//    (it only trims past 50), and while a write callback is running (the
//    offset advances after the callback). A resize in either window re-parses
//    those chunks: duplicated terminal output, escape sequences (cursor-
//    position / device-attribute queries) executed twice so their replies are
//    sent twice, and write callbacks fired a second time.
// 2. The truthiness test stops at an empty-string chunk, and the reset after
//    the loop then discards every chunk queued behind it: output silently
//    lost, callbacks that never fire.
//
// Known upstream as part of xtermjs/xterm.js#6154 (open). The maintainer's
// position there: "resize is a sync action and may not call
// WriteBuffer.flushSync" — i.e. exactly this patch. Superset hit the same
// replay and patches its own copy (superset-sh/superset#7188); their patch
// also handles an async image-decoder case we do not have (we register no
// parser handlers), so this narrower change is the right size for us.
//
// WHY IT MATTERS TO AGENT CODE SPECIFICALLY
//
// Every pane attach replays the PTY buffer as ONE chunk of up to 512 KiB
// (AGENT_PTY_BUFFER_CAP) plus the backlog — `forwarder.replay(term, [buffer,
// backlog])` in AgentTerminalLeaf / TerminalLeaf / AgentInlineTerminal — and
// then re-fits (fit() -> resize()). That is the trigger shape: the big chunk
// blows the 12 ms budget, the writer yields with it still queued, the re-fit
// flushes and re-applies it. terminalInputForwarder (#745) counts ONE write
// callback per replayed chunk to know when replay is over; a doubled callback
// ends the latch early (stale query replies are typed into the agent's stdin)
// or drives it negative (the #745 protection is off for the rest of the pane).
// Measured against the unpatched beta with the real forwarder: 7/20 simulated
// attaches leaked replies; 0/20 on 6.0.0 and 0/20 patched.
//
// WHY A SCRIPT AND NOT patch-package
//
// Both bundles are minified: lib/xterm.js is ONE 391 KB line, lib/xterm.mjs is
// 27 lines of the same. A patch-package diff carries each changed line twice
// (removed + added): about 1.1 MB of unreviewable patch across the two
// bundles (782 KB for lib/xterm.js + 350 KB for lib/xterm.mjs, measured in the
// PR #873 round-2 review). This script replaces one exact,
// verified string and refuses to do anything else, which is both smaller and
// safer: every precondition below fails the install loudly rather than
// shipping an unpatched terminal.
//
// WHERE IT RUNS (three places, each closing a different gap)
//
// 1. `postinstall` (package.json) — every `npm ci` / `npm install` /
//    `npm rebuild`, in CI and release installs too, before anything bundles.
// 2. `electron.vite.config.ts`, at config evaluation — every
//    `electron-vite dev|build|preview`, including direct invocations. Covers
//    installs that skipped lifecycle scripts (`--ignore-scripts`, an
//    interrupted install), which would otherwise bundle the unpatched core
//    with no error (PR #873 round-2 review, reproduced).
// 3. The renderer's `optimizeDeps.exclude: ['@xterm/xterm']` in the same
//    config — not a patch step but the reason 1 and 2 are sufficient in dev:
//    Vite's pre-bundle cache is keyed on the lockfile, not file contents, so a
//    copy pre-bundled before patching would otherwise be served forever.
// The guard test (xtermResizeFlushPatch.test.ts) checks node_modules; the
// packaged app bundles from node_modules after step 1 (CI/release) or step 2.
//
// WHEN THIS FAILS (by design) — READ BEFORE "FIXING" IT
//
// - Version mismatch: someone bumped @xterm/xterm. Do not just update the
//   version constant. First check whether upstream fixed the bug: look at
//   `CoreTerminal.resize` / `WriteBuffer.flushSync` in the new version and at
//   xterm.js #6154. Then either:
//
//   (a) Upstream FIXED it (resize no longer flushes, or flushSync drains from
//       `_bufferOffset` by index and does not stop at empty chunks) — REMOVE
//       THE PATCH, all of it, in one PR:
//         1. delete this file;
//         2. `package.json`: drop `node scripts/patch-xterm.mjs && ` from
//            `postinstall`;
//         3. `electron.vite.config.ts`: delete the `execFileSync(...
//            scripts/patch-xterm.mjs ...)` gate and its comment block (dev and
//            build crash with ENOENT otherwise), and the
//            `exclude: ['@xterm/xterm']` optimizeDeps entry and its comment
//            (it only exists so dev never serves a pre-patch cache);
//         4. `src/renderer/src/workspace/terminal/xtermResizeFlushPatch.test.ts`:
//            delete the module-level read of this file (test collection fails
//            with ENOENT otherwise) and the whole "is applied to both shipped
//            bundles" case (marker + no-flush assertions — the latter would
//            also be wrong if upstream kept a now-correct flush). KEEP the three
//            behaviour cases against both bundles: they are the regression
//            net for upstream's fix, and rename the file/describe accordingly;
//         5. the renderer header in xtermWebglRenderer.ts: drop the "PINNED
//            CORE IS LOCALLY PATCHED" paragraph.
//   (b) Upstream did NOT fix it — update PATCHED_XTERM_VERSION and the exact
//       RESIZE_* strings below for the new bundles, then run that test file.
// - Snippet not found exactly once: the minified shape changed for the pinned
//   version (e.g. a different minifier run). Re-derive RESIZE_BEFORE from the
//   bundle (`grep -o 'resize([a-z],[a-z]){[^}]*}' lib/xterm.mjs`).
//
// NOT PATCHED: src/common/CoreTerminal.ts inside the package. It is shipped for
// source maps only and never executed; the bundles are what run.

import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// A comment, so it costs nothing at runtime and survives in node_modules for
// the guard test to find. (Production minification strips it from out/, which
// is fine: the guard test runs against node_modules, the build's only input.)
export const XTERM_RESIZE_FLUSH_PATCH_MARKER = '/*agent-code#871:resize-does-not-flush*/'

// The exact version this patch was written and verified against. Must equal
// the exact pin in package.json — the two move together, deliberately.
export const PATCHED_XTERM_VERSION = '6.1.0-beta.304'

// Byte-identical in both 6.1.0-beta.304 bundles (verified 2026-09-11).
const RESIZE_BEFORE = 'resize(e,t){isNaN(e)||isNaN(t)||(e=Math.max(e,2),t=Math.max(t,1),this._writeBuffer.flushSync(),this._bufferService.resize(e,t))}'
const RESIZE_AFTER = `resize(e,t){isNaN(e)||isNaN(t)||(e=Math.max(e,2),t=Math.max(t,1),${XTERM_RESIZE_FLUSH_PATCH_MARKER}this._bufferService.resize(e,t))}`
const BUNDLES = ['lib/xterm.mjs', 'lib/xterm.js']

function occurrences(haystack, needle) {
  return haystack.split(needle).length - 1
}

export function patchXterm(repoRoot) {
  const require_ = createRequire(join(repoRoot, 'package.json'))
  const rootManifest = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))
  const pinned = rootManifest.dependencies?.['@xterm/xterm']
  if (pinned !== PATCHED_XTERM_VERSION) {
    throw new Error(
      `package.json pins @xterm/xterm "${pinned}" but scripts/patch-xterm.mjs was verified against ` +
      `"${PATCHED_XTERM_VERSION}". Read the "WHEN THIS FAILS" section of scripts/patch-xterm.mjs before changing either.`,
    )
  }

  const xtermDir = dirname(require_.resolve('@xterm/xterm/package.json'))
  const installed = JSON.parse(readFileSync(join(xtermDir, 'package.json'), 'utf8')).version
  if (installed !== PATCHED_XTERM_VERSION) {
    throw new Error(
      `installed @xterm/xterm is ${installed}, expected ${PATCHED_XTERM_VERSION} (the lockfile and the pin disagree, ` +
      `or a second copy was hoisted). Refusing to patch an unverified build — see scripts/patch-xterm.mjs.`,
    )
  }

  const results = []
  for (const rel of BUNDLES) {
    const file = join(xtermDir, rel)
    const source = readFileSync(file, 'utf8')
    const before = occurrences(source, RESIZE_BEFORE)
    const after = occurrences(source, RESIZE_AFTER)
    if (before === 0 && after === 1) {
      results.push(`${rel}: already patched`)
      continue
    }
    if (before !== 1 || after !== 0) {
      throw new Error(
        `${rel}: expected exactly one unpatched resize() (found ${before}) and no patched one (found ${after}). ` +
        `The bundle shape changed — see "WHEN THIS FAILS" in scripts/patch-xterm.mjs.`,
      )
    }
    writeFileSync(file, source.replace(RESIZE_BEFORE, RESIZE_AFTER))
    // Re-read rather than trust the write: a partial write here would ship a
    // broken or unpatched core.
    const verify = readFileSync(file, 'utf8')
    if (occurrences(verify, RESIZE_BEFORE) !== 0 || occurrences(verify, RESIZE_AFTER) !== 1) {
      throw new Error(`${rel}: patch did not verify after writing`)
    }
    results.push(`${rel}: patched`)
  }
  return { version: installed, results }
}

// Run only when invoked as a script (postinstall / by hand), never on import.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
  try {
    const { version, results } = patchXterm(repoRoot)
    console.log(`[patch-xterm] @xterm/xterm ${version}: resize() does not flush the write queue (#871) — ${results.join('; ')}`)
  } catch (error) {
    console.error(`[patch-xterm] FAILED: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }
}
