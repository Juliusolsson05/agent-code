#!/usr/bin/env node
// Single home of the "build unsigned when no cert" policy (#495 A6).
//
// WHY this exists: electron-builder auto-discovers a Developer ID identity
// from the keychain and fails (or produces a broken half-signature) on
// machines without one. The guard against that previously lived ONLY as
// inline shell in .github/workflows/release.yml, so `npm run dist:mac`
// worked in CI and broke on every fresh contributor Mac — the exact
// works-on-my-machine shape this issue is about. Local and CI builds now
// route through this wrapper so the policy cannot drift between them again.
//
// Signing inputs (all env): CSC_LINK/CSC_KEY_PASSWORD (cert), or CSC_NAME
// (keychain identity). When neither is present we force auto-discovery off
// and ALSO strip the APPLE_* notarization vars — electron-builder would
// otherwise try to notarize an unsigned app, which hard-fails at the end
// of a long build.
import { spawnSync } from 'node:child_process'

const env = { ...process.env }
if (!env.CSC_LINK && !env.CSC_NAME) {
  env.CSC_IDENTITY_AUTO_DISCOVERY = 'false'
  delete env.CSC_KEY_PASSWORD
  delete env.APPLE_ID
  delete env.APPLE_APP_SPECIFIC_PASSWORD
  delete env.APPLE_TEAM_ID
  console.log('[package-mac] no CSC_LINK/CSC_NAME in env — building UNSIGNED (dev) artifacts')
}

const res = spawnSync(
  'npx',
  ['electron-builder', '--mac', '--publish', 'never', ...process.argv.slice(2)],
  { stdio: 'inherit', env },
)
process.exit(res.status ?? 1)
