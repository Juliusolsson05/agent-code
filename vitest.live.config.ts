import { defineConfig } from 'vitest/config'

import { alias } from './vitest.config'

export default defineConfig({
  resolve: { alias },
  test: {
    environment: 'node',
    include: [
      'src/**/*.live.test.ts',
      'src/**/*.live.test.tsx',
      'testing/live/**/*.test.ts',
      // The in-repo Antigravity adapter's opt-in gate against the real agy.
      'packages/antigravity-acp-headless/src/**/*.live.test.ts',
    ],
  },
})
