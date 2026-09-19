# App Icon: Final Icon Composer Export

**Branch:** `chore/app-icon-final-export`, based on `origin/main` @ `f61c7a15`.
**Context:** the release thread (PR #966 → v0.0.2-beta.1) shipped the old July
icon; the owner approved the A× mark via Icon Composer on 2026-09-17 and the
final 1024 px export has been sitting in `~/Downloads` since. This PR puts it
in the box before the next release build.

## Goal

The packaged app, its DMG, and Finder all show the final Icon Composer mark
instead of the interim July icon.

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
- `build/app-icon.svg` is now a superseded intermediate. It stays in the tree
  (git history is the safer archive than deletion mid-release), but this plan
  is the record that the raster Icon Composer export — not the SVG — is the
  icon source of truth from here on.

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
