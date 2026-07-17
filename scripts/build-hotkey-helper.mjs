#!/usr/bin/env node
// Build-time compile of the macOS dictation-hotkey helper (#495 A4).
//
// WHY this exists: macHotkeyHelper.ts used to compile
// native/macos-hotkey-helper/.../main.swift ON THE END-USER'S MACHINE via
// `xcrun swiftc` the first time the dictation hotkey was configured. That
// silently required Xcode Command Line Tools on every Mac that runs the
// packaged app — a Mac without CLT lost the dictation hotkey with nothing
// but a console.warn nobody sees. Compiling here, on the BUILD host (dev
// Macs and the macos-latest CI runner both have CLT), and shipping the
// binary inside the app removes that end-user requirement entirely.
//
// WHY the output lands under out/main/runtime/: that subtree is already
// listed in electron-builder.yml's `asarUnpack` (`out/main/runtime/**/*`),
// already survives packaging as real files (executables cannot be spawned
// from inside an asar), and electron-builder signs unpacked Mach-O binaries
// with the app's hardenedRuntime entitlements — so no new packaging or
// signing plumbing is needed. Runtime resolution mirrors the bundled
// mitmproxy path (src/main/setup/runtimeTools.ts unpackAsarPath).
//
// WHY a universal (arm64 + x86_64) binary: out/main is built ONCE on one
// build host and the same staged tree feeds BOTH per-arch dmgs (the
// bundled runtime tools under out/main/runtime are likewise all-arch, with
// per-arch selection at runtime). A host-arch-only helper would ship an
// arm64 Mach-O inside the x64 dmg and die with a bad-CPU-type spawn error.
// Two thin slices + lipo is the standard fix; the Swift source is tiny so
// the double compile costs ~2s.
//
// WHY hard-fail (exit 1) on any compile error: the whole point of this
// script is "build hosts must have CLT so end users don't need it". A
// build host without a working swiftc should break the build loudly, not
// quietly ship an app with dictation silently degraded.
import { spawnSync } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// fileURLToPath, not new URL(...).pathname — see the WHY in
// scripts/copy-packaged-resources.mjs (percent-encoded spaces would break
// every fs call for a checkout under a path with spaces).
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

if (process.platform !== 'darwin') {
  // The helper is a CGEventTap process — macOS-only by definition, and the
  // only packaged artifacts that consume it are the mac dmgs. On any other
  // build platform this step is a documented no-op, not a failure.
  console.log('[build-hotkey-helper] non-darwin build host — skipping (mac-only artifact)')
  process.exit(0)
}

const source = join(
  repoRoot,
  'native/macos-hotkey-helper/Sources/AgentVoiceHotkeyHelper/main.swift',
)
const outDir = join(repoRoot, 'out/main/runtime/hotkey-helper')
const target = join(outDir, 'AgentCodeDictationHotkeyHelper')
mkdirSync(outDir, { recursive: true })

function run(cmd, args) {
  const res = spawnSync(cmd, args, { stdio: 'inherit' })
  if (res.error) {
    console.error(`[build-hotkey-helper] failed to run ${cmd}:`, res.error.message)
    process.exit(1)
  }
  if (res.status !== 0) {
    console.error(
      `[build-hotkey-helper] ${cmd} ${args.join(' ')} exited with ${res.status}. ` +
        'Build hosts must have Xcode Command Line Tools (xcode-select --install).',
    )
    process.exit(1)
  }
}

// Deployment target follows electron-builder.yml. Electron 38+ requires
// Monterey, so keeping older helper slices buys no real compatibility and can
// hide accidental use of APIs unavailable at the application's true floor.
const slices = [
  { arch: 'arm64', triple: 'arm64-apple-macos12.0' },
  { arch: 'x86_64', triple: 'x86_64-apple-macos12.0' },
]

const slicePaths = []
for (const slice of slices) {
  const slicePath = `${target}.${slice.arch}`
  run('/usr/bin/xcrun', ['swiftc', source, '-O', '-target', slice.triple, '-o', slicePath])
  slicePaths.push(slicePath)
}

run('/usr/bin/lipo', ['-create', ...slicePaths, '-output', target])
for (const slicePath of slicePaths) rmSync(slicePath, { force: true })

console.log(`[build-hotkey-helper] built universal helper at ${target}`)
