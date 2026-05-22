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

const alias = [
  { find: /^claude-code-headless\/(.+)$/, replacement: `${resolve(root, 'packages/claude-code-headless/src')}/$1` },
  { find: 'claude-code-headless', replacement: resolve(root, 'packages/claude-code-headless/src/index.ts') },
  { find: /^codex-headless\/(.+)$/, replacement: `${resolve(root, 'packages/codex-headless/src')}/$1` },
  { find: 'codex-headless', replacement: resolve(root, 'packages/codex-headless/src/index.ts') },
  { find: /^agent-transcript-parser\/(.+)$/, replacement: `${resolve(root, 'packages/agent-transcript-parser/src')}/$1` },
  { find: 'agent-transcript-parser', replacement: resolve(root, 'packages/agent-transcript-parser/src/index.ts') },
  { find: /^agent-voice-dictation\/(.+)$/, replacement: `${resolve(root, 'packages/agent-voice-dictation/src')}/$1/index.ts` },
  { find: 'agent-voice-dictation', replacement: resolve(root, 'packages/agent-voice-dictation/src/index.ts') },
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
  '**/testing/rendering/**',
  // WHY this package is excluded here:
  //
  // agent-voice-dictation already owns package-local `node --test` coverage
  // for its speech/browser surfaces. Pulling those tests into the app runner
  // would make the root suite responsible for DOM/audio provider behavior that
  // belongs to the package. App-level dictation integration can still add
  // colocated tests under src/ when it has an Agent Code invariant to protect.
  'packages/agent-voice-dictation/src/**/*.test.ts',
]

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
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          environment: 'node',
          include: [
            'testing/unit/**/*.test.ts',
            'src/**/*.test.ts',
            'packages/**/*.test.ts',
          ],
          exclude: [
            ...exclude,
            '**/*.integration.test.ts',
            '**/*.renderer.test.ts',
          ],
        },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          environment: 'node',
          include: [
            'testing/integration/**/*.integration.test.ts',
            'src/**/*.integration.test.ts',
            'packages/**/*.integration.test.ts',
          ],
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
            'testing/renderer/**/*.renderer.test.ts',
            'testing/renderer/**/*.renderer.test.tsx',
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
      reporter: ['text', 'html'],
      reportsDirectory: 'coverage',
    },
  },
})
