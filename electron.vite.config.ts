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

const headlessExclude = ['claude-code-headless', 'codex-headless', 'agent-transcript-parser']

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: headlessExclude })],
    resolve: { alias: headlessAlias },
    build: {
      rollupOptions: {
        input: resolve(__dirname, 'src/main/index.ts')
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin({ exclude: headlessExclude })],
    resolve: { alias: headlessAlias },
    build: {
      rollupOptions: {
        input: resolve(__dirname, 'src/preload/index.ts')
      }
    }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
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
