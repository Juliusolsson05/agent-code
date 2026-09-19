#!/usr/bin/env node
// Which tag, name and release flags a manual release dispatch publishes
// (.github/workflows/release.yml, validate-release job).
//
// WHY a script and not inline workflow bash: these rules decide whether a
// signed build becomes `releases/latest`, which the landing page's download
// button and every "latest" link resolve to. The nightly logic moved out of
// YAML for the same reason after the #1012 review found three defects there
// that nothing could have caught. testing/system/release/identity.test.ts
// runs this file as a real process with the workflow's env.
//
// Inputs (env): CHANNEL ('prerelease' | 'stable', default 'prerelease'),
// RELEASE_TAG and RELEASE_NAME (both optional; derived from package.json when
// empty), GITHUB_OUTPUT. Writes tag, name, prerelease and make_latest, or
// exits 1 with the reason BEFORE the 26-minute build starts.
//
// Only Node built-ins, so the Ubuntu job needs no `npm ci`.

import { appendFileSync, readFileSync } from 'node:fs'

const CHANNELS = ['prerelease', 'stable']

function fail(message) {
  process.stderr.write(`${message}\n`)
  process.exit(1)
}

const channel = process.env.CHANNEL || 'prerelease'
if (!CHANNELS.includes(channel)) fail(`Unknown release channel ${JSON.stringify(channel)}; use one of: ${CHANNELS.join(', ')}.`)

const version = JSON.parse(readFileSync('package.json', 'utf8')).version
if (typeof version !== 'string' || version.length === 0) fail('package.json has no version.')

// A semver prerelease is anything after a '-' in the version core
// (0.0.2-beta.1). The channel must agree with it both ways:
// - a stable release of a prerelease version would make a beta `latest`;
// - a prerelease of a stable version would take the stable tag (v0.1.0), and
//   the real stable release could then never be created under it.
const isPrereleaseVersion = version.includes('-')
if (channel === 'stable' && isPrereleaseVersion) {
  fail(`A stable release needs a stable version, but package.json is ${version}. Bump it (for example to ${version.split('-')[0]}) first.`)
}
if (channel === 'prerelease' && !isPrereleaseVersion) {
  fail(`A prerelease needs a prerelease version, but package.json is ${version}. Use the stable channel, or bump to ${version}-beta.1.`)
}

const expectedTag = `v${version}`
const tag = process.env.RELEASE_TAG || expectedTag
if (tag !== expectedTag) fail(`Release tag must match package.json exactly: expected ${expectedTag}, got ${tag}.`)
const name = process.env.RELEASE_NAME || `Agent Code ${version}`

const stable = channel === 'stable'
const outputs = {
  tag,
  name,
  prerelease: stable ? 'false' : 'true',
  // Strings, because softprops/action-gh-release takes "true", "false" or
  // "legacy". GitHub refuses to make a prerelease latest anyway; saying
  // "false" keeps a beta from ever being the fallback latest.
  make_latest: stable ? 'true' : 'false',
}
const target = process.env.GITHUB_OUTPUT
if (!target) fail('GITHUB_OUTPUT is not set.')
appendFileSync(target, Object.entries(outputs).map(([key, value]) => `${key}=${value}\n`).join(''))
