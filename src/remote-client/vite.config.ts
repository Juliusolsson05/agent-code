import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Build config for the phone client — a PLAIN Vite app, deliberately not an
// electron-vite target: the client has no Electron surface at all (it runs
// in a phone browser), and keeping it out of the desktop build means the
// desktop pipeline cannot grow accidental dependencies on it (the isolation
// wall, enforced at build level).
//
// Output lands in out/remote-client, next to electron-vite's out/main and
// out/preload; main/index.ts serves it from there when present (see the
// clientDistDir wiring). base './' because the bundle is served by
// RemoteServer at whatever host:port the transport picked.

export default defineConfig({
  root: __dirname,
  base: './',
  plugins: [react()],
  resolve: {
    alias: {
      // Only @shared — the client consumes the SessionFeed contract and its
      // event types, nothing else from the app. Adding @renderer here is a
      // deliberate future decision (it drags the desktop component graph
      // into this bundle), not a convenience import away.
      '@shared': resolve(__dirname, '..', 'shared'),
    },
  },
  build: {
    outDir: resolve(__dirname, '..', '..', 'out', 'remote-client'),
    emptyOutDir: true,
  },
})
