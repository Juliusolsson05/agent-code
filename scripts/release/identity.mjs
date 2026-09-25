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
// Every manual release is STABLE (RELEASE.md, "Channels"; decided
// 2026-09-24). Previews of the next version are cut automatically every
// night by .github/workflows/preview.yml, which replaced both the rolling
// `nightly` and the hand-cut `-beta.N` prereleases this script used to
// accept through a `channel` input. One manual path that can only produce a
// stable release means nobody can publish a beta as `latest`, or a stable as
// a beta, by picking the wrong option on the dispatch form.
//
// Inputs (env): RELEASE_TAG and RELEASE_NAME (both optional; derived from
// package.json when empty), GITHUB_OUTPUT. Writes tag, name, prerelease and
// make_latest, or exits 1 with the reason BEFORE the 26-minute build starts.
//
// Only Node built-ins, so the Ubuntu job needs no `npm ci`.

import { appendFileSync, readFileSync } from 'node:fs'

function fail(message) {
  process.stderr.write(`${message}\n`)
  process.exit(1)
}

const version = JSON.parse(readFileSync('package.json', 'utf8')).version
if (typeof version !== 'string' || version.length === 0) fail('package.json has no version.')

// A semver prerelease is anything after a '-' in the version core
// (0.0.2-beta.1). A stable release of one would make a beta `latest` and hand
// it to every install through the updater. Build metadata (`+…`) is not part
// of precedence and may itself contain a hyphen (0.1.0+build-5), so only the
// part before '+' decides.
if (version.split('+')[0].includes('-')) {
  fail(`Manual releases are always stable, but package.json is ${version}. Bump it to a stable version (for example ${version.split('+')[0].split('-')[0]}) first. Previews of the next version are published automatically by the preview workflow.`)
}

const expectedTag = `v${version}`
const tag = process.env.RELEASE_TAG || expectedTag
if (tag !== expectedTag) fail(`Release tag must match package.json exactly: expected ${expectedTag}, got ${tag}.`)
const name = process.env.RELEASE_NAME || `Agent Code ${version}`
// GITHUB_OUTPUT is `key=value` lines, and a repeated key keeps its LAST
// value, so a newline in a free-text input could append `tag=…` and replace
// the validated tag (#1035 review). Refuse line breaks outright.
for (const [label, value] of [['release_tag', tag], ['release_name', name]]) {
  if (/[\r\n]/u.test(value)) fail(`${label} must be a single line.`)
}

const outputs = {
  tag,
  name,
  prerelease: 'false',
  // Strings, because softprops/action-gh-release takes "true", "false" or
  // "legacy". Kept as outputs (rather than hardcoded in release.yml) so the
  // release step and these tests read one decision.
  // KNOWN LIMIT (#1035 review): re-dispatching an OLDER stable (say v0.1.0
  // after v0.2.0 shipped) also sends true and takes `latest` back. Nothing
  // here can see the published releases without a token; do not re-publish an
  // old stable, or set it back from the Releases page afterwards.
  make_latest: 'true',
}
const target = process.env.GITHUB_OUTPUT
if (!target) fail('GITHUB_OUTPUT is not set.')
appendFileSync(target, Object.entries(outputs).map(([key, value]) => `${key}=${value}\n`).join(''))
