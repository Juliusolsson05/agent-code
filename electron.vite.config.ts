import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { copyFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { resolve } from 'path'
import type { Plugin } from 'vite'

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
  // `agent-voice-dictation` is a git submodule like the other local packages,
  // so cc-shell must compile it from source. Relying on `dist` would make a
  // fresh clone fail unless someone remembered to build the submodule first,
  // and that hidden ordering dependency is exactly what the packages/ layout
  // is meant to avoid.
  { find: /^agent-voice-dictation\/(.+)$/, replacement: `${resolve(__dirname, 'packages/agent-voice-dictation/src')}/$1/index.ts` },
  { find: 'agent-voice-dictation', replacement: resolve(__dirname, 'packages/agent-voice-dictation/src/index.ts') },
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

const headlessExclude = ['claude-code-headless', 'codex-headless', 'agent-transcript-parser', 'agent-voice-dictation']

function copyMainRuntimeResourcesPlugin(): Plugin {
  const resources = [
    {
      from: resolve(__dirname, 'packages/claude-code-headless/src/testing/proxy-testing/mitmAddon.py'),
      to: resolve(__dirname, 'out/main/mitmAddon.py'),
    },
  ]

  const copyResources = async () => {
    await Promise.all(resources.map(async resource => {
      await mkdir(dirname(resource.to), { recursive: true })
      await copyFile(resource.from, resource.to)
    }))
  }

  return {
    name: 'cc-shell-copy-main-runtime-resources',
    apply: 'build',
    async closeBundle() {
      // WHY this lives in the Vite main build instead of only in
      // `npm run build:app`:
      //
      // Claude proxy streaming starts from the bundled main process,
      // and the proxy launcher resolves `mitmAddon.py` beside
      // `out/main/index.js` first. `electron-vite dev` rewrites that
      // output without running the package-level build script, so the
      // addon disappears in development and every Claude proxy spawn
      // becomes "Unable to locate mitmAddon.py". Copying from the
      // main bundle lifecycle keeps dev, preview, and production
      // builds on the same resource contract.
      await copyResources()
    },
  }
}

export default defineConfig({
  main: {
    plugins: [
      externalizeDepsPlugin({ exclude: headlessExclude }),
      copyMainRuntimeResourcesPlugin(),
    ],
    resolve: { alias: [...headlessAlias, ...Object.entries(projectAlias).map(([find, replacement]) => ({ find, replacement }))] },
    build: {
      rollupOptions: {
        input: resolve(__dirname, 'src/main/index.ts'),
        // `agent-voice-dictation` uses `ws` for Deepgram streaming. Main runs
        // in Node, so bundling `ws` through Vite is the wrong tradeoff: Rollup
        // can inline the optional bufferutil fallback into a shape where
        // `bufferUtil.mask` is not a function, causing a crash on every audio
        // chunk send. Leave `ws` external and let Node/Electron resolve the
        // package at runtime, matching the standalone dictation app's proven
        // Electron config.
        external: ['ws']
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
