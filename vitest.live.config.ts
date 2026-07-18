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
    ],
  },
})
