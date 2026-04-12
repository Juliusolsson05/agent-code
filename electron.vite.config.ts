import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'path'

// Resolve claude-code-headless from the submodule source directly.
// Only main + preload use the package (it imports Node APIs like
// EventEmitter, chokidar, fs). The renderer CANNOT import it — Vite
// would try to bundle Node modules for the browser and fail. Renderer
// imports the pure types/parsers from src/shared/ instead.
const headlessAlias = {
  'claude-code-headless': resolve(__dirname, 'claude-code-headless/src/index.ts'),
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: ['claude-code-headless'] })],
    resolve: { alias: headlessAlias },
    build: {
      rollupOptions: {
        input: resolve(__dirname, 'src/main/index.ts')
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin({ exclude: ['claude-code-headless'] })],
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
