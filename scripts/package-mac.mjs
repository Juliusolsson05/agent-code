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
// and ALSO strip EVERY notarization-credential env var — electron-builder
// would otherwise try to notarize an unsigned app, which hard-fails at the
// end of a long build.
//
// WHY the list is longer than APPLE_ID/APPLE_APP_SPECIFIC_PASSWORD/
// APPLE_TEAM_ID: app-builder-lib's getNotarizeOptions() (see
// node_modules/app-builder-lib/out/macPackager.js) has THREE independent
// credential paths, any of which arms notarization:
//   1. APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD (+ APPLE_TEAM_ID)
//   2. APPLE_API_KEY + APPLE_API_KEY_ID + APPLE_API_ISSUER (App Store
//      Connect API key — common on developer Macs that also ship other
//      apps, exported in ~/.zshrc and forgotten)
//   3. APPLE_KEYCHAIN_PROFILE (+ optional APPLE_KEYCHAIN) — a stored
//      `notarytool store-credentials` profile
// And notarization is NOT gated on a real signature: on arm64 the
// no-identity path falls back to AD-HOC signing (fallBackToAdhoc in
// macPackager.sign()) and then still calls notarizeIfProvided(), so a dev
// with only path-2/3 creds exported would watch the whole "UNSIGNED"
// build succeed and then die in notarytool at the very end. Stripping
// only path 1 (the original shape of this block) left exactly that hole.
import { spawnSync } from 'node:child_process'

const env = { ...process.env }

// WHY empty signing vars are deleted, not just treated as falsy: GitHub
// Actions materialises `${{ secrets.CSC_LINK }}` as an EMPTY STRING when the
// secret does not exist, and release.yml passes every signing secret that way.
// electron-builder deliberately treats "" as a set value
// (platformPackager.getCscLink: chooseNotNull + "allow to specify as empty
// string"), so an empty CSC_LINK is resolved as a certificate PATH relative to
// the project root and packaging dies with "<repo> not a file" (#965, release
// run 34739476044). The `!env.CSC_LINK` test below already chose the unsigned
// branch correctly; the empty variable simply survived into the child env.
// Normalising first makes "secret missing" and "variable unset" identical for
// everything downstream, including the notarization vars.
for (const name of ['CSC_LINK', 'CSC_NAME', 'CSC_KEY_PASSWORD']) {
  if (env[name] !== undefined && env[name].trim() === '') delete env[name]
}

if (!env.CSC_LINK && !env.CSC_NAME) {
  env.CSC_IDENTITY_AUTO_DISCOVERY = 'false'
  delete env.CSC_KEY_PASSWORD
  const notarizationVars = [
    'APPLE_ID',
    'APPLE_APP_SPECIFIC_PASSWORD',
    'APPLE_TEAM_ID',
    'APPLE_API_KEY',
    'APPLE_API_KEY_ID',
    'APPLE_API_ISSUER',
    'APPLE_KEYCHAIN_PROFILE',
    'APPLE_KEYCHAIN',
  ]
  // Log the names (never the values) of the creds we're ignoring so a dev
  // wondering "why wasn't my build notarized?" gets the answer in the build
  // output instead of re-deriving this policy from source.
  const ignored = notarizationVars.filter((name) => env[name] !== undefined)
  for (const name of notarizationVars) delete env[name]
  console.log('[package-mac] no CSC_LINK/CSC_NAME in env — building UNSIGNED (dev) artifacts')
  if (ignored.length > 0) {
    console.log(
      `[package-mac] ignoring notarization env vars (unsigned apps cannot be notarized): ${ignored.join(', ')}`,
    )
  }
}

const res = spawnSync(
  'npx',
  ['electron-builder', '--mac', '--publish', 'never', ...process.argv.slice(2)],
  { stdio: 'inherit', env },
)
process.exit(res.status ?? 1)
