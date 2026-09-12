import { spawn } from 'node:child_process'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { build as buildRenderer } from 'vite'

// This deliberately launches a separate Electron instance with its own state.
// A DOM emulator cannot prove custom-scheme origins, iframe sandboxing, CSP or
// file-origin postMessage delivery. Bundle the production bridge and installer,
// replacing only the state-root module, so the test cannot touch user data.
const repo = resolve(fileURLToPath(new URL('..', import.meta.url)))
const runtimeOnly = process.argv.includes('--runtime-only')
const preloadArgument = process.argv.indexOf('--runtime-preload')
const runtimePreload = preloadArgument < 0 ? null : process.argv[preloadArgument + 1]
if (preloadArgument >= 0 && (!runtimeOnly || !runtimePreload || runtimePreload.startsWith('--'))) {
  throw new Error('--runtime-preload requires --runtime-only and a built preload file path')
}
// Electron 43's normal import downloads a missing binary lazily. Tests must be
// offline: download it during dependency setup instead, and fail with an action
// the developer can take if that setup was skipped.
const electronPackage = dirname(createRequire(import.meta.url).resolve('electron/package.json'))
let electron
try {
  electron = join(electronPackage, 'dist', (await readFile(join(electronPackage, 'path.txt'), 'utf8')).trim())
  await access(electron)
} catch {
  throw new Error('Prepare the Electron test dependency first: node node_modules/electron/install.js')
}
const root = await mkdtemp(join(tmpdir(), 'agent-code-extension-frames-'))
try {
  const paths = join(root, 'paths.ts')
  await writeFile(paths, `import { join } from 'node:path';
const root = process.env.AGENT_CODE_EXTENSION_TEST_ROOT;
if (!root) throw new Error('An isolated extension test root is required');
export const STATE_DIR = join(root, 'state');
export const EXTENSIONS_DIR = join(STATE_DIR, 'extensions');
export const EXTENSIONS_LOCKFILE = join(STATE_DIR, 'extensions.json');
export const EXTENSION_STATE_DIR = join(STATE_DIR, 'extension-state');
`)
  await build({
    absWorkingDir: repo, entryPoints: [runtimeOnly ? 'src/main/extensions/testing/runtimeHarness.ts' : 'src/main/extensions/testing/electronHarness.ts'],
    outfile: join(root, 'main.cjs'), bundle: true, platform: 'node', format: 'cjs',
    external: ['electron'], alias: { '@main/storage/paths.js': paths },
    tsconfig: 'tsconfig.node.json', logLevel: 'warning',
  })
  if (runtimePreload) {
    await access(resolve(runtimePreload))
  } else {
  await build({
    absWorkingDir: repo, entryPoints: [runtimeOnly ? 'src/preload/extensionRuntime.ts' : 'src/main/extensions/testing/electronPreload.ts'],
    outfile: join(root, 'preload.cjs'), bundle: true, platform: 'node', format: 'cjs',
    external: ['electron'], tsconfig: 'tsconfig.node.json', logLevel: 'warning',
  })
  }
  if (!runtimeOnly) {
    await build({
      absWorkingDir: repo, entryPoints: ['src/preload/extensionRuntime.ts'],
      outfile: join(root, 'runtime-preload.cjs'), bundle: true, platform: 'node', format: 'cjs',
      external: ['electron'], tsconfig: 'tsconfig.node.json', logLevel: 'warning',
    })
    const rendererStarted = performance.now()
    console.log('Building the production extension view bridge fixture…')
    // Use the app's renderer bundler so imported UI keeps Vite's asset/?worker
    // semantics as coverage grows. No app config/env loading: that would run
    // unrelated packaging hooks and could read local service credentials.
    await buildRenderer({
      root: repo, configFile: false, envDir: false, base: './', logLevel: 'warn',
      resolve: { alias: {
        '@renderer': join(repo, 'src/renderer/src'), '@shared': join(repo, 'src/shared'),
        '@providers': join(repo, 'src/providers'), '@mcp': join(repo, 'src/mcp'),
        '@control-sdk': join(repo, 'src/control-sdk'),
        'agent-transcript-parser': join(repo, 'packages/agent-transcript-parser/src'),
      } },
      esbuild: { jsx: 'automatic', jsxDev: false },
      define: { 'process.env.NODE_ENV': '"production"' },
      build: {
        outDir: root, emptyOutDir: false, minify: false, reportCompressedSize: false,
        lib: { entry: join(repo, 'src/renderer/src/apps/host/testing/electronHarness.tsx'), name: 'ExtensionFixture', formats: ['iife'], fileName: () => 'renderer.js', cssFileName: 'renderer' },
      },
    })
    console.log(`Renderer fixture built in ${Math.round((performance.now() - rendererStarted) / 1000)} seconds`)
    const { buildAuthorFixture } = await import('../packages/agent-code-extension-api/testing/buildAuthorFixture.mjs')
    await buildAuthorFixture(join(root, 'author-bundle'))
    // Use the shipped parent CSP as well as the child's production policy. A
    // permissive test host would miss a packaging change that blocks embedding or
    // teardown even while all child-side origin assertions keep passing.
    const hostDocument = await readFile(join(repo, 'src/renderer/index.html'), 'utf8')
    const csp = hostDocument.match(/<meta\s+http-equiv="Content-Security-Policy"[\s\S]*?\/>/)?.[0]
    if (!csp) throw new Error('Cannot locate the production renderer CSP')
    const css = await access(join(root, 'renderer.css')).then(() => '<link rel="stylesheet" href="renderer.css">', () => '')
    await writeFile(join(root, 'host.html'), `<!doctype html><meta charset="utf-8">${csp}${css}<body><div id="host"></div><script src="renderer.js"></script>`)
  }
  const env = { ...process.env, AGENT_CODE_EXTENSION_TEST_ROOT: root, AGENT_CODE_EXTENSION_RUNTIME_PRELOAD: runtimePreload ? resolve(runtimePreload) : join(root, 'preload.cjs') }
  delete env.ELECTRON_RUN_AS_NODE
  await new Promise((resolve, reject) => {
    const child = spawn(electron, [join(root, 'main.cjs')], { env, stdio: 'inherit' })
    // A hung runtime is one of the scenarios. The app's own deadline should win;
    // this outer deadline prevents a broken test from leaving a hidden app alive.
    const deadline = setTimeout(() => { child.kill('SIGKILL') }, 60_000)
    child.once('error', error => { clearTimeout(deadline); reject(error) })
    child.once('exit', (code, signal) => {
      clearTimeout(deadline)
      if (code === 0) resolve()
      else reject(new Error(`Extension Electron checks failed (${signal ?? code})`))
    })
  })
  // Exit zero alone can also mean an early app shutdown; require the harness to
  // reach its final assertion and finish teardown on direct runs as well as CI.
  if (await readFile(join(root, 'completed'), 'utf8').catch(() => '') !== 'ok') {
    throw new Error('Electron exited before completing the integration assertions')
  }
} finally {
  await rm(root, { recursive: true, force: true })
}
