import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { execFileSync, execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { copyFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { resolve } from 'path'
import type { Plugin } from 'vite'

// ---------------------------------------------------------------------------
// @xterm/xterm core patch gate (#871) — see scripts/patch-xterm.mjs for the
// bug. The pinned 6.1.0 beta's resize() replays/drops queued writes; the
// script removes that flush from both installed bundles.
//
// WHY run it HERE as well as from `postinstall` (PR #873 round-2 review):
// postinstall is skipped by `npm ci --ignore-scripts` (a legitimate way to
// avoid the native rebuild) and by an interrupted install, and nothing else
// in dev/build would notice — the build succeeds and bundles the unpatched
// core. This config is evaluated once per `electron-vite dev|build|preview`,
// including direct invocations that bypass the npm scripts, so it is the one
// choke point every renderer bundle passes through. The script is idempotent
// ("already patched" in the normal case) and exits non-zero on any version or
// bundle-shape mismatch; execFileSync then throws and the command aborts —
// deliberately, because shipping the unpatched core is the failure we are
// preventing. A child process (like the git provenance calls below) rather
// than an import keeps this TypeScript config free of an untyped .mjs.
// ---------------------------------------------------------------------------
execFileSync(process.execPath, [resolve(__dirname, 'scripts/patch-xterm.mjs')], { stdio: 'inherit' })

// Resolve headless packages from the submodule sources directly.
// Only main + preload use these (they import Node APIs like
// EventEmitter, chokidar, fs). The renderer CANNOT import them —
// Vite would try to bundle Node modules for the browser and fail.
const headlessAlias = [
  { find: /^claude-code-headless\/(.+)$/, replacement: `${resolve(__dirname, 'packages/claude-code-headless/src')}/$1` },
  { find: 'claude-code-headless', replacement: resolve(__dirname, 'packages/claude-code-headless/src/index.ts') },
  { find: /^codex-headless\/(.+)$/, replacement: `${resolve(__dirname, 'packages/codex-headless/src')}/$1` },
  { find: 'codex-headless', replacement: resolve(__dirname, 'packages/codex-headless/src/index.ts') },
  { find: /^opencode-headless\/(.+)$/, replacement: `${resolve(__dirname, 'packages/opencode-headless/src')}/$1` },
  { find: 'opencode-headless', replacement: resolve(__dirname, 'packages/opencode-headless/src/index.ts') },
  // The native-TUI OpenCode runtime's reader. Main-only like its siblings: it
  // loads node:sqlite and talks HTTP/SSE to the TUI's own server.
  { find: /^opencode-terminal-headless\/(.+)$/, replacement: `${resolve(__dirname, 'packages/opencode-terminal-headless/src')}/$1` },
  { find: 'opencode-terminal-headless', replacement: resolve(__dirname, 'packages/opencode-terminal-headless/src/index.ts') },
  { find: /^agent-transcript-parser\/(.+)$/, replacement: `${resolve(__dirname, 'packages/agent-transcript-parser/src')}/$1` },
  { find: 'agent-transcript-parser', replacement: resolve(__dirname, 'packages/agent-transcript-parser/src/index.ts') },
  // `agent-voice-dictation` is a git submodule like the other local packages,
  // so Agent Code must compile it from source. Relying on `dist` would make a
  // fresh clone fail unless someone remembered to build the submodule first,
  // and that hidden ordering dependency is exactly what the packages/ layout
  // is meant to avoid.
  { find: /^agent-voice-dictation\/(.+)$/, replacement: `${resolve(__dirname, 'packages/agent-voice-dictation/src')}/$1/index.ts` },
  { find: 'agent-voice-dictation', replacement: resolve(__dirname, 'packages/agent-voice-dictation/src/index.ts') },
  // workflow-mcp deliberately exposes a browser-safe state entry. Keep it
  // before the package-root alias: alias order is load-bearing, and letting
  // the root swallow `/state` would drag fs, child_process, the MCP SDK, and
  // the Codex SDK into a browser bundle.
  { find: 'workflow-mcp/state', replacement: resolve(__dirname, 'packages/workflow-mcp/src/state.ts') },
  { find: 'workflow-mcp/worker', replacement: resolve(__dirname, 'packages/workflow-mcp/src/worker.ts') },
  { find: 'workflow-mcp', replacement: resolve(__dirname, 'packages/workflow-mcp/src/index.ts') },
]

// Project-wide absolute-import aliases. MUST match tsconfig.node.json
// + tsconfig.web.json `paths` — the two resolvers must agree or tsc
// will green-light an import the runtime can't load. Keep the alias
// names and targets in sync across all three configs.
const projectAlias = {
  '@control-sdk/host': resolve(__dirname, 'src/control-sdk/host.ts'),
  '@control-sdk': resolve(__dirname, 'src/control-sdk/index.ts'),
  '@main': resolve(__dirname, 'src/main'),
  '@preload': resolve(__dirname, 'src/preload'),
  '@renderer': resolve(__dirname, 'src/renderer/src'),
  '@shared': resolve(__dirname, 'src/shared'),
  '@providers': resolve(__dirname, 'src/providers'),
  '@mcp': resolve(__dirname, 'src/mcp'),
}

const headlessExclude = [
  'claude-code-headless',
  'codex-headless',
  'opencode-headless',
  'opencode-terminal-headless',
  'agent-transcript-parser',
  'agent-voice-dictation',
  // Compile the submodule from source so a recursive clone does not have a
  // hidden "build the child package first" prerequisite.
  'workflow-mcp',
]

function copyMainRuntimeResourcesPlugin(): Plugin {
  const resources = [
    {
      // WHY this copies from `src/proxy`, not the older
      // `src/testing/proxy-testing` harness path:
      //
      // claude-code-headless promoted the MITM addon into the production proxy
      // module so the package build can copy it beside `dist/proxyServer.js`.
      // Agent Code aliases that package from source, bypassing the package's
      // own build script, so this Vite hook is the app-level equivalent of
      // that copy. Pointing at the retired testing harness makes preview/dist
      // fail before Electron even launches on fresh submodule checkouts.
      from: resolve(__dirname, 'packages/claude-code-headless/src/proxy/mitmAddon.py'),
      to: resolve(__dirname, 'out/main/mitmAddon.py'),
    },
  ]

  const copyResources = async () => {
    await Promise.all(resources.map(async resource => {
      await mkdir(dirname(resource.to), { recursive: true })
      await copyFile(resource.from, resource.to)
    }))
  }

  return {
    name: 'agent-code-copy-main-runtime-resources',
    apply: 'build',
    async closeBundle() {
      // WHY this lives in the Vite main build instead of only in
      // `npm run build:app`:
      //
      // Claude proxy streaming starts from the bundled main process,
      // and the proxy launcher resolves `mitmAddon.py` beside
      // `out/main/index.js` first. `electron-vite dev` rewrites that
      // output without running the package-level build script, so the
      // addon disappears in development and every Claude proxy spawn
      // becomes "Unable to locate mitmAddon.py". Copying from the
      // main bundle lifecycle keeps dev, preview, and production
      // builds on the same resource contract.
      await copyResources()
    },
  }
}

// ---------------------------------------------------------------------------
// Build provenance (issue #374) — computed at CONFIG-EVALUATION time and
// injected into the main bundle via `define` below. This is the builder's
// answer to "which exact source produced this binary?": incident artifacts
// (run manifests, app.run.started events, debug bundles) stamp these values so
// a stale local dev run can never masquerade as origin/main during crash
// triage.
//
// WHY config time and not runtime: a packaged app has no .git directory, and
// even in dev, shelling out to git from the Electron main process would add a
// synchronous subprocess to the startup hot path. The config is evaluated once
// per build / dev-server start, which is exactly the granularity at which the
// source state can change.
//
// WHY try/catch around every git call: CI tarballs, shallow/cache checkouts
// without .git, or a machine without git installed must yield 'unknown'
// values, NEVER a failed build — provenance is forensics, not a build gate
// (same invariant as the incident journal itself: the diagnostic layer must
// never break the product).
// ---------------------------------------------------------------------------

function gitOutput(cmd: string): string {
  try {
    // stderr ignored: a non-repo checkout prints "fatal: not a git repository"
    // which would pollute every build log despite being an expected case.
    return execSync(cmd, { cwd: __dirname, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || 'unknown'
  } catch {
    return 'unknown'
  }
}

function gitDirty(): boolean | 'unknown' {
  try {
    // Any porcelain output (staged, unstaged, or untracked) counts as dirty:
    // triage cares whether the SHA fully identifies the source, and an
    // untracked-but-imported file breaks that just as much as an edit.
    return execSync('git status --porcelain', { cwd: __dirname, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().length > 0
  } catch {
    // 'unknown', not false — absence of evidence must not read as "clean".
    return 'unknown'
  }
}

function readPackageVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf8')) as { version?: unknown }
    return typeof pkg.version === 'string' ? pkg.version : 'unknown'
  } catch {
    return 'unknown'
  }
}

// Keep this shape byte-compatible with `BuildInfo` in src/main/buildInfo.ts —
// that module is the ONLY consumer of the injected global and documents every
// field. (Not imported here to keep the config free of src/ imports; the
// fallback-spread in getBuildInfo() tolerates drift by materializing missing
// fields as 'unknown'.)
function computeBuildProvenance(mode: string): Record<string, unknown> {
  return {
    gitSha: gitOutput('git rev-parse HEAD'),
    branch: gitOutput('git rev-parse --abbrev-ref HEAD'),
    dirty: gitDirty(),
    buildTimestamp: new Date().toISOString(),
    buildMode: mode,
    packageVersion: readPackageVersion(),
  }
}

export default defineConfig(({ mode }) => ({
  main: {
    plugins: [
      externalizeDepsPlugin({ exclude: headlessExclude }),
      copyMainRuntimeResourcesPlugin(),
    ],
    // JSON.stringify is load-bearing: Vite `define` values are injected as raw
    // source text, so the stringified object becomes an object-literal
    // expression at every reference site. An un-stringified value would be
    // spliced as invalid code. Main-process only — the renderer must not
    // carry provenance it would only ever round-trip back to main.
    define: {
      __AGENT_CODE_BUILD_INFO__: JSON.stringify(computeBuildProvenance(mode)),
    },
    resolve: { alias: [...headlessAlias, ...Object.entries(projectAlias).map(([find, replacement]) => ({ find, replacement }))] },
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          // utilityProcess.fork needs a real module entry rather than a
          // function buried in the main bundle. The stable input name keeps
          // dev, preview, and packaged paths identical.
          workflowWorker: resolve(__dirname, 'src/main/workflows/workflowWorkerEntry.ts'),
          // child_process.fork cannot address a function buried in the main
          // bundle. A stable sibling entry gives every Codex attempt its own
          // killable process group in preview and the packaged application;
          // changing this name also requires changing createWorkflowService.
          workflowProviderHost: resolve(__dirname, 'src/main/workflows/workflowProviderHostEntry.ts'),
        },
        // `agent-voice-dictation` uses `ws` for Deepgram streaming. Main runs
        // in Node, so bundling `ws` through Vite is the wrong tradeoff: Rollup
        // can inline the optional bufferutil fallback into a shape where
        // `bufferUtil.mask` is not a function, causing a crash on every audio
        // chunk send. Leave `ws` external and let Node/Electron resolve the
        // package at runtime, matching the standalone dictation app's proven
        // Electron config.
        external: [
          'ws',
          // workflow-mcp is compiled from submodule source, but its parser and
          // schema validator are ordinary production dependencies. Bundling
          // acorn's CommonJS distribution through electron-vite currently
          // corrupts one generated shim inside the 1MB+ main chunk; leaving
          // both dependencies external preserves their tested Node entry
          // points and lets electron-builder package them from node_modules.
          'acorn',
          'ajv',
        ]
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin({ exclude: headlessExclude })],
    resolve: { alias: [...headlessAlias, ...Object.entries(projectAlias).map(([find, replacement]) => ({ find, replacement }))] },
    build: {
      rollupOptions: {
        input: resolve(__dirname, 'src/preload/index.ts')
      }
    }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    resolve: { alias: [...headlessAlias, ...Object.entries(projectAlias).map(([find, replacement]) => ({ find, replacement }))] },
    build: {
      rollupOptions: {
        input: resolve(__dirname, 'src/renderer/index.html')
      }
    },
    plugins: [react(), tailwindcss()],
    optimizeDeps: {
      include: ['monaco-editor'],
      // Never pre-bundle the patched xterm core (#871, PR #873 round-2 review).
      // Vite's dev optimizer caches a pre-bundled copy keyed on the lockfile
      // and config — NOT on the dependency's file contents — so a copy
      // pre-bundled before scripts/patch-xterm.mjs ran (e.g. dev started on an
      // unpatched revision or after `--ignore-scripts`) would keep being served
      // after the patch succeeded, with the guard test (which reads
      // node_modules) still green. Reproduced with this repo's Vite 7.3.6.
      // Excluded, Vite serves node_modules/@xterm/xterm/lib/xterm.mjs itself,
      // so dev always runs the patched file. Safe: that bundle is plain ESM
      // with no imports of its own, and the add-ons do not import the core.
      // Dev-only — production builds bundle straight from node_modules.
      exclude: ['@xterm/xterm'],
    }
  }
}))
