import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

// WHY the test runner owns this alias map instead of importing it from
// electron.vite.config.ts:
//
// The Electron config has build-time plugins, resource-copy side effects, and
// main/preload/renderer split targets. Pulling that whole file into Vitest
// would make "run a reducer test" depend on Electron build concerns. The alias
// map is duplicated deliberately so tests resolve the same source modules while
// keeping the runner boring and side-effect free. If the application alias map
// changes, update this file in the same PR.
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

export default defineConfig({
  plugins: [react()],
  resolve: { alias },
  test: {
    environment: 'node',
    exclude: [
      '**/node_modules/**',
      '**/out/**',
      '**/.tsc-out/**',
      '**/vendor/**',
      '**/testing/rendering/out/**',
      'packages/agent-voice-dictation/src/**/*.test.ts',
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      reportsDirectory: 'coverage',
    },
  },
})

