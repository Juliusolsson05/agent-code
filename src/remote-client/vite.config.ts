import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

// Build config for the phone client — a PLAIN Vite app, deliberately not an
// electron-vite target: the client has no Electron surface at all (it runs
// in a phone browser), and keeping it out of the desktop build means the
// desktop pipeline cannot grow accidental dependencies on it (the isolation
// wall, enforced at build level).
//
// The phone mounts the REAL desktop feed modules — every row, CodeBlock,
// link and toast is the same source the desktop renders. Until #1177 it got
// there by SUBSTITUTING six desktop-coupled modules with stubs through the
// alias table below; the stubs had to mirror each module's exports by hand,
// one (the app store) was invisible to the type checker, and every desktop
// change to those modules silently risked the phone. They are gone: what a
// row may do on a given device now arrives typed through the RendererHost
// context (host/phoneRendererHost.ts here, DesktopRendererHost on the
// desktop) and the shared toast context. If the phone bundle ever needs a
// substitution again, the fix is a host capability, not an alias.
//
// What remains below is path mapping only: the source aliases every build
// shares, plus two exact package entries that must precede the general
// prefixes (vite's array-form aliases match top-down).

const src = resolve(__dirname, '..')

export default defineConfig({
  root: __dirname,
  base: './',
  plugins: [
    react(),
    // The desktop feed components are Tailwind-4 classed against the app
    // theme tokens; importing @renderer/styles.css (whose @source
    // directives already scan src/providers + src/shared) gives the phone
    // the identical visual system, applied via applyTheme() at boot.
    tailwindcss(),
  ],
  resolve: {
    alias: [
      // The shared workflow row reduces clean events. This exact alias keeps
      // the phone on the pure reducer entry instead of importing Node/Electron
      // runtime surfaces from the package root.
      {
        find: 'workflow-mcp/state',
        replacement: resolve(src, '..', 'packages', 'workflow-mcp', 'src', 'state.ts'),
      },
      {
        // The live-window planner imports the pure parser ghost helpers even
        // though the phone has no ghost plane. Resolve pinned source just as
        // the desktop build does: file: package exports point at dist/, which
        // exists on a warmed developer checkout but not in a clean CI clone.
        // Do not externalize it; the phone needs a self-contained browser bundle.
        find: 'agent-transcript-parser/ghost',
        replacement: resolve(src, '..', 'packages', 'agent-transcript-parser', 'src', 'ghost.ts'),
      },
      { find: '@renderer', replacement: resolve(src, 'renderer', 'src') },
      { find: '@providers', replacement: resolve(src, 'providers') },
      { find: '@shared', replacement: resolve(src, 'shared') },
      { find: '@mcp', replacement: resolve(src, 'mcp') },
      // Other parser references are type-only. Keep runtime leaf imports
      // source-aliased above; headless packages never enter the phone bundle.
    ],
  },
  build: {
    outDir: resolve(src, '..', 'out', 'remote-client'),
    emptyOutDir: true,
  },
})
