import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'path'

const repoRoot = resolve(__dirname, '../..')

// WHY `packages/*` and not a bare root path: the headless workspaces live under
// `packages/` (see the repo `packages/` dir + tsconfig `paths`). An earlier
// version of this config aliased them to `repoRoot/claude-code-headless/...`,
// directories that do not exist in this checkout — so `testing:rendering:build`
// could not resolve the package imports at all. These must stay byte-for-byte
// in step with the `paths` maps in tsconfig.node.json / tsconfig.web.json and
// the `resolve.alias` map in the app's electron.vite.config.ts; if they drift,
// the harness type-checks/bundles against a module graph the app cannot load.
const headlessAlias = {
  'claude-code-headless': resolve(repoRoot, 'packages/claude-code-headless/src/index.ts'),
  'codex-headless': resolve(repoRoot, 'packages/codex-headless/src/index.ts'),
  'agent-transcript-parser': resolve(repoRoot, 'packages/agent-transcript-parser/src/index.ts'),
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
        // Dedicated harness main — no tmux, no workspace, no LSP, no
        // switch-provider. See testing/rendering/main.ts for the WHY.
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
        input: resolve(repoRoot, 'src/preload/index.ts'),
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
