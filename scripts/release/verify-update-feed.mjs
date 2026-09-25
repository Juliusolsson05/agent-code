#!/usr/bin/env node
// Checks that the update feed only names files that are about to be uploaded
// (.github/workflows/release.yml, package-macos job, after packaging and
// before upload).
//
// WHY (#1129): electron-updater reads latest-mac.yml and downloads the file it
// names from the SAME release. v0.1.0–v0.1.2 shipped a feed naming
// `Agent-Code-0.1.2-arm64.zip` while the build produced
// `Agent Code-0.1.2-arm64.zip` (electron-builder writes the feed assuming its
// own publisher turns the space into a dash; we upload with
// softprops/action-gh-release and GitHub turns it into a dot). Every update
// download 404'd and nothing noticed, because the only thing that ever reads
// the feed is an installed app in the field. Here the feed and the files sit
// side by side, so a mismatch is visible before anything is published.
//
// Two checks, because exact-name matching alone has a blind spot: GitHub
// keeps only letters, digits, `.`, `-` and `_` unchanged on upload. A name
// with any other character could match here and still be renamed on the
// release, which is the #1129 bug again one step later.
//
// Only Node built-ins, like identity.mjs. The feed format is a small, stable
// electron-builder output; the two fields read here (`url` entries under
// `files`, and the top-level `path`) are all the updater downloads by name.
//
// Usage: node scripts/release/verify-update-feed.mjs [releaseDir=release] [feed=latest-mac.yml]
//
// The feed name is an argument since #1168: the preview workflow publishes
// `preview-mac.yml` on the rolling `preview` release, the Preview update
// channel's feed, and it must pass the same two checks.

import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const releaseDir = resolve(process.cwd(), process.argv[2] ?? 'release')
const feedName = process.argv[3] ?? 'latest-mac.yml'
const feedPath = join(releaseDir, feedName)

function fail(message) {
  process.stderr.write(`[verify-update-feed] ${message}\n`)
  process.exit(1)
}

if (!existsSync(feedPath)) {
  fail(`${feedPath} is missing. Without it the updater cannot see this release; check the publish block in electron-builder.yml.`)
}

const referenced = new Set()
for (const line of readFileSync(feedPath, 'utf8').split('\n')) {
  // Matches `  - url: X`, `    url: X` and the top-level `path: X`. Values
  // are unquoted in electron-builder's output, but strip quotes defensively.
  const match = /^\s*(?:-\s+)?(url|path):\s*(.+?)\s*$/.exec(line)
  if (match) referenced.add(match[2].replace(/^(['"])(.*)\1$/, '$2'))
}
if (referenced.size === 0) fail(`${feedPath} names no files; the updater would have nothing to download.`)

const rewritten = [...referenced].filter(name => !/^[A-Za-z0-9._-]+$/.test(name))
if (rewritten.length > 0) {
  fail(
    `${feedName} names files GitHub would rename on upload (only letters, digits, ".", "-" and "_" survive), so installed apps would get 404 when updating:\n`
    + rewritten.map(name => `  - ${name}`).join('\n')
    + '\nChange artifactName in electron-builder.yml to use only those characters.',
  )
}

const missing = [...referenced].filter(name => !existsSync(join(releaseDir, name)))
if (missing.length > 0) {
  fail(
    `${feedName} names files that are not in ${releaseDir}, so installed apps would get 404 when updating:\n`
    + missing.map(name => `  - ${name}`).join('\n')
    + '\nThe feed is written from artifactName in electron-builder.yml; the file names on disk must match it exactly.',
  )
}

process.stdout.write(`[verify-update-feed] OK: ${referenced.size} feed entries match files in ${releaseDir}\n`)
