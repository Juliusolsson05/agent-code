import { access } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'

const requiredOutputs = [
  'out/main/index.js',
  'out/main/performanceWorker.js',
  // WHY `.mjs` is the contract here: electron-vite emits the preload as ESM,
  // and `createMainWindow()` loads this exact runtime path. Accepting the old
  // `.js` name would let CI bless a build that Electron cannot actually load;
  // requiring it made every healthy build fail after the preload moved to ESM.
  'out/preload/index.mjs',
  'out/renderer/index.html',
  'out/remote-client/index.html',
  // Pi panes hand this path to `pi -e`; without it every Pi pane degrades to
  // a plain TUI with no status or transcript, which no other check would catch.
  'out/main/runtime/pi/bridge.ts',
]

const missing = []
for (const output of requiredOutputs) {
  try {
    await access(join(process.cwd(), output))
  } catch {
    missing.push(output)
  }
}

if (missing.length > 0) {
  console.error('The build completed without required application entry points:')
  for (const output of missing) console.error(`- ${output}`)
  process.exitCode = 1
} else {
  console.log('Application build contains every required entry point')
}
