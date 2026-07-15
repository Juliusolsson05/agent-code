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
// THE ALIAS TABLE BELOW IS THE PHONE'S COMPATIBILITY CONTRACT with the
// desktop renderer (see docs/superpowers/specs/2026-07-06-remote-semantic-
// rendering-design.md). The phone mounts the REAL desktop feed components —
// zero rendering drift — and every module that would drag Electron/desktop
// coupling into the bundle is substituted here, at build level, with a stub
// under src/stubs/ that documents its divergence. Adding an entry to this
// table is a conscious decision; anything NOT listed renders with literally
// the same code the desktop runs.
//
// ORDER MATTERS: vite's array-form aliases match top-down, so the exact
// stub substitutions MUST precede the general @renderer prefix mapping.

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
      // --- stub substitutions (desktop-coupled modules) ---
      {
        // monaco + LSP-over-window.api; stub is static-hljs with the same
        // props type and markup contract.
        find: '@renderer/lib/code/CodeBlock',
        replacement: resolve(__dirname, 'src', 'stubs', 'CodeBlock'),
      },
      {
        // zustand app store; the feed subtree's single read gets a frozen
        // default-settings snapshot.
        find: '@renderer/app-state/hooks',
        replacement: resolve(__dirname, 'src', 'stubs', 'appStateHooks'),
      },
      {
        // perf spans over IPC; no-ops.
        find: '@renderer/performance/client',
        replacement: resolve(__dirname, 'src', 'stubs', 'perfClient'),
      },
      {
        // external-open IPC + Global Editor routing; plain new-tab anchor.
        find: '@renderer/features/rendered-content/SafeMarkdownLink',
        replacement: resolve(__dirname, 'src', 'stubs', 'SafeMarkdownLink'),
      },
      {
        // click-to-open-in-editor inline code; plain <code>.
        find: '@renderer/features/rendered-content/SafeInlineCode',
        replacement: resolve(__dirname, 'src', 'stubs', 'SafeInlineCode'),
      },
      // --- real desktop source (everything else) ---
      // The shared workflow row reduces clean events. This exact alias keeps
      // the phone on the pure reducer entry instead of importing Node/Electron
      // runtime surfaces from the package root.
      {
        find: 'workflow-mcp/state',
        replacement: resolve(src, '..', 'packages', 'workflow-mcp', 'src', 'state.ts'),
      },
      { find: '@renderer', replacement: resolve(src, 'renderer', 'src') },
      { find: '@providers', replacement: resolve(src, 'providers') },
      { find: '@shared', replacement: resolve(src, 'shared') },
      { find: '@mcp', replacement: resolve(src, 'mcp') },
      // agent-transcript-parser is a file: workspace package; the desktop
      // resolves it via node_modules symlink, which works here too — no
      // alias needed. The headless packages never appear in renderer code.
    ],
  },
  build: {
    outDir: resolve(src, '..', 'out', 'remote-client'),
    emptyOutDir: true,
  },
})
