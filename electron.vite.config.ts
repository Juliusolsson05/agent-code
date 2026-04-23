import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'path'

// Resolve headless packages from the submodule sources directly.
// Only main + preload use these (they import Node APIs like
// EventEmitter, chokidar, fs). The renderer CANNOT import them —
// Vite would try to bundle Node modules for the browser and fail.
const headlessAlias = {
  'claude-code-headless': resolve(__dirname, 'claude-code-headless/src/index.ts'),
  'codex-headless': resolve(__dirname, 'codex-headless/src/index.ts'),
  'agent-transcript-parser': resolve(__dirname, 'agent-transcript-parser/src/index.ts'),
}

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
    resolve: { alias: { ...headlessAlias, ...projectAlias } },
    build: {
      rollupOptions: {
        input: resolve(__dirname, 'src/main/index.ts')
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin({ exclude: headlessExclude })],
    resolve: { alias: { ...headlessAlias, ...projectAlias } },
    build: {
      rollupOptions: {
        input: resolve(__dirname, 'src/preload/index.ts')
      }
    }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    resolve: { alias: projectAlias },
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
