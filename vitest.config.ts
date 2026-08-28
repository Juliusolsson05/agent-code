import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

// WHY Vitest owns a slightly different Vite surface than the application today:
//
// The app is still built through electron-vite's Vite 5 pipeline, while
// Vitest 4 currently brings a newer Vite runtime for tests. That can print
// plugin deprecation warnings even when the tests are correct. We accept that
// drift for this ground-zero test-stack PR because pinning Vitest backward
// would lock the new suite to an older runner before the rendering rewrite has
// even started. If those warnings become failures, fix the Electron/Vite stack
// deliberately instead of papering over them in individual tests.
//
// WHY the test runner owns this alias map instead of importing it from
// electron.vite.config.ts:
//
// The Electron config has build-time plugins, resource-copy side effects, and
// main/preload/renderer split targets. Pulling that whole file into Vitest
// would make "run a reducer test" depend on Electron build concerns. The alias
// map is duplicated deliberately so tests resolve the same source modules while
// keeping the runner boring and side-effect free. If the application alias map
// changes, update this file in the same PR.
//
// IMPORTANT: there is no automated guard for that duplication yet. A broken
// alias here means tests can pass against a module graph that the actual app
// cannot load, which is worse than no test because it creates false confidence.
const root = import.meta.dirname

export const alias = [
  { find: /^claude-code-headless\/(.+)$/, replacement: `${resolve(root, 'packages/claude-code-headless/src')}/$1` },
  { find: 'claude-code-headless', replacement: resolve(root, 'packages/claude-code-headless/src/index.ts') },
  { find: /^codex-headless\/(.+)$/, replacement: `${resolve(root, 'packages/codex-headless/src')}/$1` },
  { find: 'codex-headless', replacement: resolve(root, 'packages/codex-headless/src/index.ts') },
  // Drift fix: electron.vite.config.ts gained opencode-headless when the
  // third provider landed; this map (deliberately duplicated — see the WHY
  // above) did not. Any test whose import graph reaches
  // providers/registry.main.ts needs it.
  { find: /^opencode-headless\/(.+)$/, replacement: `${resolve(root, 'packages/opencode-headless/src')}/$1` },
  { find: 'opencode-headless', replacement: resolve(root, 'packages/opencode-headless/src/index.ts') },
  { find: /^agent-transcript-parser\/(.+)$/, replacement: `${resolve(root, 'packages/agent-transcript-parser/src')}/$1` },
  { find: 'agent-transcript-parser', replacement: resolve(root, 'packages/agent-transcript-parser/src/index.ts') },
  { find: /^agent-voice-dictation\/(.+)$/, replacement: `${resolve(root, 'packages/agent-voice-dictation/src')}/$1/index.ts` },
  { find: 'agent-voice-dictation', replacement: resolve(root, 'packages/agent-voice-dictation/src/index.ts') },
  { find: 'workflow-mcp/state', replacement: resolve(root, 'packages/workflow-mcp/src/state.ts') },
  { find: 'workflow-mcp/worker', replacement: resolve(root, 'packages/workflow-mcp/src/worker.ts') },
  { find: 'workflow-mcp', replacement: resolve(root, 'packages/workflow-mcp/src/index.ts') },
  { find: '@main', replacement: resolve(root, 'src/main') },
  { find: '@preload', replacement: resolve(root, 'src/preload') },
  { find: '@renderer', replacement: resolve(root, 'src/renderer/src') },
  { find: '@shared', replacement: resolve(root, 'src/shared') },
  { find: '@providers', replacement: resolve(root, 'src/providers') },
  { find: '@mcp', replacement: resolve(root, 'src/mcp') },
]

const exclude = [
  '**/node_modules/**',
  '**/out/**',
  '**/.tsc-out/**',
  '**/vendor/**',
]

// WHY these arrays are exported instead of being buried inside defineConfig:
// the suffix split is an execution-safety boundary, not merely organization.
// A system/live/soak/corpus file can start processes, bind sockets, or require
// credentials. Keeping the exact patterns inspectable lets a focused contract
// test prevent a future broad `**/*.test.ts` edit from silently pulling those
// files back into the parallel core project.
export // ── `.tsx` IS INCLUDED SO A TEST CANNOT FALL BETWEEN PROJECTS ──
// The renderer project takes only `*.renderer.test.tsx`, and this one used to take
// only `.ts`. A file named `Foo.test.tsx` therefore matched NO project: vitest ran
// it nowhere, reported success, and `check-test-contract.mjs` — which greps for
// `.only`, not for project membership — agreed. A test that silently never runs is
// worse than a missing one, because the coverage it appears to provide is counted.
//
// Every one of the ~300 current test files maps to exactly one project, so this
// closes a hole rather than fixing a live miss. A `.tsx` test that needs a DOM must
// still be named `*.renderer.test.tsx`; this catches the ones that do not.
const unitTestIncludes = [
  'testing/unit/**/*.test.ts',
  'src/**/*.test.ts',
  'src/**/*.test.tsx',
] as const

// Every tier suffix, in BOTH extensions.
//
// The `.tsx` half is not decorative: the unit project's include list covers
// `src/**/*.test.tsx`, and `*.renderer.test.tsx` matches that glob too. Without the
// `.tsx` excludes here, every renderer test would ALSO be collected into the
// node-environment unit project and fail with "document is not defined" — which is
// exactly what happened the first time the include was widened.
export const unitTierExcludes = [
  '**/*.integration.test.ts',
  '**/*.renderer.test.ts',
  '**/*.renderer.test.tsx',
  '**/*.system.test.ts',
  '**/*.system.test.tsx',
  '**/*.live.test.ts',
  '**/*.live.test.tsx',
  '**/*.soak.test.ts',
  '**/*.soak.test.tsx',
  '**/*.corpus.test.ts',
  '**/*.corpus.test.tsx',
] as const

export const systemTestIncludes = [
  'testing/system/**/*.test.ts',
  'src/**/*.system.test.ts',
  // WHY the legacy suffix stays accepted: Agent Code already has useful
  // operating-system-boundary coverage under `.integration.test.ts`. Renaming
  // those files is review noise and would not change their execution contract;
  // new cross-boundary tests should use the shared `.system.test.ts` suffix.
  'src/**/*.integration.test.ts',
] as const

export default defineConfig({
  resolve: { alias },
  // WHY projects instead of CLI flags:
  //
  // Renderer tests need happy-dom and shared setup. Encoding that only in
  // `npm run test:renderer` makes `vitest`, `vitest run --coverage`, IDE runs,
  // and single-file runs silently default to Node and fail with "document is
  // not defined". Projects make the environment part of the test file contract,
  // so every entry point sees the same layer split.
  test: {
    // WHY there is no global retry here: the shared testing standard treats a
    // first-attempt failure as evidence. Polling scenarios must own generous
    // monotonic deadlines and cleanup; retrying the complete assertion would
    // hide scheduler-sensitive leaks and make local/CI behavior disagree.
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          environment: 'node',
          // WHY package tests are not swept into this project: every submodule
          // owns its private suite and CI environment. Agent Code tests package
          // integration through public APIs under src/, otherwise a submodule's
          // serial system or opt-in live test can be reclassified as a parallel
          // app unit test merely because Git checked out the source tree.
          include: [...unitTestIncludes],
          exclude: [
            ...exclude,
            ...unitTierExcludes,
          ],
        },
      },
      {
        extends: true,
        test: {
          name: 'system',
          environment: 'node',
          // Electron 43 validates/downloads its binary lazily from index.js
          // when an integration import reaches `electron`. Starting several
          // fresh project workers at the same instant can make those workers
          // race the same dist extraction and fail with EEXIST even though the
          // installed binary is healthy. Integration files are few and mostly
          // I/O-bound; serial files remove that package-installer race without
          // slowing the large pure-unit/renderer suites.
          fileParallelism: false,
          include: [...systemTestIncludes],
          exclude,
        },
      },
      {
        extends: true,
        plugins: [react()],
        test: {
          name: 'renderer',
          environment: 'happy-dom',
          include: [
            'src/**/*.renderer.test.ts',
            'src/**/*.renderer.test.tsx',
          ],
          exclude,
          setupFiles: ['./testing/setup/renderer.ts'],
        },
      },
    ],
    coverage: {
      provider: 'v8',
      // WHY CI prints only the aggregate: a per-file report for this application
      // is tens of thousands of lines and hides the actual failing assertion in
      // GitHub logs. The HTML artifact retains complete drill-down data.
      reporter: ['text-summary', 'json-summary', 'html'],
      reportsDirectory: 'coverage',
      // WHY the application declares its denominator: V8 otherwise reports
      // only modules imported by today's tests. Untested preload, remote-client,
      // and main-process code would disappear instead of showing up at zero,
      // turning the coverage job into a misleading activity counter.
      include: ['src/**/*.ts', 'src/**/*.tsx'],
      // WHY imported package sources are excluded explicitly: V8 can retain
      // modules loaded through Agent Code's source aliases even when include is
      // app-only. Each submodule has its own honest coverage gate; counting the
      // same file here at near-zero would violate the ownership boundary and
      // make a pointer update rewrite Agent Code's baseline.
      exclude: ['packages/**'],
      // WHY the first floor matches the measured all-app baseline: this turns
      // coverage into a ratchet immediately without pretending the existing
      // application has already covered every Electron/UI boundary. New tests
      // should raise the relevant number in the same PR.
      thresholds: { statements: 32, branches: 30, functions: 27, lines: 34 },
    },
  },
})
