# App Icon: Final Icon Composer Export

**Branch:** `chore/app-icon-final-export`, based on `origin/main` @ `f61c7a15`.
**Context:** the release thread (PR #966 → v0.0.2-beta.1) shipped the July
icon: a green dragon curled around a `</>` glyph on black. On 2026-09-17 the
owner re-colored that same dragon + `</>` mark into the Nord palette
(`~/Downloads/Agent Code Logo.png`, 16:51), exported it through Icon Composer
minutes later (16:53), and adopted the same set on the landing page (landing
repo commit `b95013d`, "retheme to Nord and adopt the new logo set"). This PR
ships that Icon Composer export before the next release build.

**Correction (PR review, 2026-09-19):** the first version of this plan, and the
body of commit `5a1e6f2e`, called this "the A× mark". That was wrong. The A×
concept (an extruded A whose legs cross into a ×, chosen 2026-09-15, SVG layers
in `~/Desktop/agent-code-logo/`) never reached an Icon Composer export. The
export in this PR is the dragon + `</>` mark. Two independent reviewers compared
the rendered images and confirmed it. Future sessions: do not "restore" A× from
this history. The dragon is what the owner shipped on both the site and the app.

## Goal

The packaged app, its DMG, and Finder all show the Nord dragon + `</>` mark
instead of the July green one.

## Source of truth and consumers (verified, do not re-derive)

- Source: `~/Downloads/Icon-iOS-Default-1024x1024@1x.png` — 1024×1024, alpha,
  exported from Icon Composer 2026-09-17. `sips` confirms dimensions; its
  sha256 differs from the current `build/icon.png` (i.e. this is a real
  change, not a no-op copy).
- `electron-builder.yml` consumes exactly one icon: `mac.icon: build/icon.icns`
  (line 75). No `win`/`linux` icon entries exist, no `dmg.background` art
  exists, and neither `verify-build-output.mjs` nor `package-mac.mjs` mentions
  icons — so there is nothing else to update for the packaging surface.
- The comment above `mac.icon` records why the .icns is committed: without it,
  electron-builder regenerates one from `build/icon.png` at pack time via
  sips/iconutil, which is host-dependent. That contract is preserved: we
  regenerate the .icns deterministically here and commit the result.
- `build/app-icon.svg` is **the vector master of the glyph**, not a superseded
  file. Its path data matches the glyph layer of the owner's Icon Composer
  document exactly; only the fills differ, per the PR review. It is not a build
  input, since nothing references it. It is the only copy of this mark that
  scales past 1024 px (favicons, DMG art, print), so never delete it as cleanup.
  The raster export is what builds use; the SVG is where the shape lives.
- WHY a raster export and not a `.icon` document: electron-builder 26 accepts an
  Icon Composer `.icon` for `mac.icon` directly, but compiles it with `actool`,
  which needs Xcode 26 on the build host. That is exactly the host dependence
  the committed-.icns contract (#495 A18) exists to remove, so the release
  build stays a pure sips/iconutil path. The regeneration recipe is now written
  inline in `electron-builder.yml` next to `mac.icon`.
- Known, pre-existing, out of scope: the export is an iOS-style full-bleed tile
  with no transparent margin. macOS 26 insets it automatically, but macOS 12–15
  draw an .icns exactly as it is, so the Dock tile there looks about 24% larger
  than its neighbours. The July icon had the identical alpha shape, so this is
  not a regression. It is tracked as its own issue, because adding padding is
  a visual change to decide on its own merits.

## Changes

1. Replace `build/icon.png` with the 1024 px export byte-for-byte (it is both
   the human-viewable source and electron-builder's regeneration fallback).
2. Regenerate `build/icon.icns` from that PNG with the standard 10-entry
   iconset (16/32/128/256/512 + @2x) via `sips` + `iconutil -c icns`, so the
   committed artifact remains reproducible from `build/icon.png` alone.

## Verification

- `iconutil -c iconset` roundtrip on the new .icns lists all 10 entries.
- The new .icns hash differs from the old one (real change), and
  `git status` shows only `build/icon.png` + `build/icon.icns` touched.
- No build is needed locally to prove the packaged icon: `mac.icon` points at
  the committed .icns directly, and CI's quality-gate is unaffected (no
  icon-sensitive checks exist). The next release workflow run picks it up.

## Out of scope

- Landing-page favicon/touch icons: already updated with the logo set in the
  landing repo's Nord retheme (merged PR #2 there).
- README screenshots (pre-Nord, stale): separate release-polish work.
