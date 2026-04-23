import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'path'

// Resolve headless packages from the submodule sources directly.
// Only main + preload use these (they import Node APIs like
// EventEmitter, chokidar, fs). The renderer CANNOT import them —
// Vite would try to bundle Node modules for the browser and fail.
const headlessAlias = [
  { find: /^claude-code-headless\/(.+)$/, replacement: `${resolve(__dirname, 'packages/claude-code-headless/src')}/$1` },
  { find: 'claude-code-headless', replacement: resolve(__dirname, 'packages/claude-code-headless/src/index.ts') },
  { find: /^codex-headless\/(.+)$/, replacement: `${resolve(__dirname, 'packages/codex-headless/src')}/$1` },
  { find: 'codex-headless', replacement: resolve(__dirname, 'packages/codex-headless/src/index.ts') },
  { find: /^agent-transcript-parser\/(.+)$/, replacement: `${resolve(__dirname, 'packages/agent-transcript-parser/src')}/$1` },
  { find: 'agent-transcript-parser', replacement: resolve(__dirname, 'packages/agent-transcript-parser/src/index.ts') },
]

// Project-wide absolute-import aliases. MUST match tsconfig.node.json
// + tsconfig.web.json `paths` — the two resolvers must agree or tsc
// will green-light an import the runtime can't load. Keep the alias
// names and targets in sync across all three configs.
const projectAlias = {
  '@main': resolve(__dirname, 'src/main'),
  '@preload': resolve(__dirname, 'src/preload'),
  '@renderer': resolve(__dirname, 'src/renderer/src'),
  '@shared': resolve(__dirname, 'src/shared'),
  '@providers': resolve(__dirname, 'src/providers'),
}

const headlessExclude = ['claude-code-headless', 'codex-headless', 'agent-transcript-parser']

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: headlessExclude })],
    resolve: { alias: [...headlessAlias, ...Object.entries(projectAlias).map(([find, replacement]) => ({ find, replacement }))] },
    build: {
      rollupOptions: {
        input: resolve(__dirname, 'src/main/index.ts')
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
      include: ['monaco-editor']
    }
  }
})
