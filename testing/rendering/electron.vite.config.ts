import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'path'

const repoRoot = resolve(__dirname, '../..')

const headlessAlias = {
  'claude-code-headless': resolve(repoRoot, 'claude-code-headless/src/index.ts'),
  'codex-headless': resolve(repoRoot, 'codex-headless/src/index.ts'),
  'agent-transcript-parser': resolve(repoRoot, 'agent-transcript-parser/src/index.ts'),
  '@renderer': resolve(repoRoot, 'src/renderer/src'),
  '@shared': resolve(repoRoot, 'src/shared'),
  '@providers': resolve(repoRoot, 'src/providers'),
}

const headlessExclude = ['claude-code-headless', 'codex-headless', 'agent-transcript-parser']

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: headlessExclude })],
    resolve: { alias: headlessAlias },
    build: {
      outDir: resolve(__dirname, 'out/main'),
      rollupOptions: {
        input: resolve(__dirname, 'main.ts'),
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin({ exclude: headlessExclude })],
    resolve: { alias: headlessAlias },
    build: {
      outDir: resolve(__dirname, 'out/preload'),
      rollupOptions: {
        input: resolve(__dirname, 'preload.ts'),
      },
    },
  },
  renderer: {
    root: resolve(__dirname, 'renderer'),
    resolve: { alias: headlessAlias },
    server: {
      fs: {
        allow: [repoRoot],
      },
    },
    build: {
      outDir: resolve(__dirname, 'out/renderer'),
      rollupOptions: {
        input: resolve(__dirname, 'renderer/index.html'),
      },
    },
    plugins: [react(), tailwindcss()],
    optimizeDeps: {
      include: ['monaco-editor'],
    },
  },
})
