# Self-update fix plan

Fixes #1129 (every self-update download 404s) and #1130 (Check for Updates gives
no feedback for most outcomes). Builds on the auto-update work in #1120 / PR #1122.

## What is broken

1. **The feed points at files that do not exist.** `artifactName` is
   `${productName}-${version}-${arch}.${ext}`, which yields
   `Agent Code-0.1.2-arm64.zip` (a space). electron-builder writes
   `latest-mac.yml` assuming its own GitHub publisher, which uploads that name
   as `Agent-Code-…`. We upload with `softprops/action-gh-release` instead, and
   GitHub stores the space as a dot: `Agent.Code-…`. The updater asks for
   `Agent-Code-0.1.2-arm64.zip` and gets 404. True for v0.1.0, v0.1.1 and v0.1.2.
2. **Manual checks are mostly silent.** `UpdateService` only notifies on
   `ready` and `error`, and only through OS notifications. Disabled (a build run
   from source), up to date, and found-and-downloading say nothing. The
   `ready` copy names a "Restart to update" item that does not exist, and
   clicking **Check for Updates…** while ready quits without asking.
3. `release/*.yml` uploads `builder-debug.yml` to every release.

## Changes

### Artifact names (#1129)

- `electron-builder.yml`: set both `artifactName` entries (top level and
  `dmg`) to `Agent-Code-${version}-${arch}.${ext}`. No space means nothing
  rewrites the name: the local file, the feed entry and the uploaded asset are
  the same string.
  - Why fix the name at the source rather than renaming files in the workflow:
    electron-builder writes `latest-mac.yml` from `artifactName` and records a
    sha512 per file. Renaming after the fact would have to rewrite the feed
    too, and local builds would still produce a feed that disagrees with the
    files next to it.
  - Why a literal `Agent-Code` rather than `${name}` (`agent-code`): release
    downloads keep the product's capitalisation, and the landing page only
    matches the `-<arch>.dmg` ending, so either works; the literal is the
    smaller visible change.
  - The nightly is unaffected: `scripts/release/nightly.mjs` renames files
    by their `-<arch>.<ext>` ending to fixed `Agent.Code-nightly-…` names the
    landing page links to.
- `release.yml`: upload `release/latest-mac.yml` instead of `release/*.yml`
  (both the artifact upload and the GitHub release upload), dropping the
  stray `builder-debug.yml`.

### Feed verification (#1129 regression guard)

- New `scripts/release/verify-update-feed.mjs`: reads `release/latest-mac.yml`
  and fails unless every `url`/`path` it names exists in `release/` with
  exactly that name, no name contains characters GitHub rewrites on upload,
  and every zip has its `.blockmap`. Runs in `release.yml` right after
  packaging, before upload, so a mismatch fails the release instead of
  shipping.
- Node built-ins only (a line parser for the two fields we need), matching
  `scripts/release/identity.mjs`.
- Test: `testing/system/release/updateFeed.test.ts` runs the script as a real
  process against the **recorded v0.1.2 feed** (`testing/fixtures/`), with the
  file names the old template actually produced locally. It must fail on
  those and pass once the names match.

### Manual-check feedback (#1130)

- `UpdateService` gains an injected `showMessage(message, confirmLabel?)`
  returning whether the confirm button was chosen (production: a native
  `dialog.showMessageBox`, which shows even when notifications are off).
- New `menuCheck()` owns the menu's dual duty, moving it out of `index.ts`
  into the tested service:
  - disabled: "Updates are only available in the installed Agent Code app."
  - ready: confirm dialog "Agent Code X is ready to install. Restart now?";
    only **Restart** calls `restartToUpdate()` (still the vetoable quit path).
  - already available/downloading: say it is downloading.
  - otherwise: forced check, then report the outcome of THAT check once:
    up to date (with the current version), found and downloading (with the
    new version), or the error copy.
- Background checks (startup, interval, resume) stay silent apart from the
  existing ready/error notifications.
- Fix the `ready` notification copy to name the real menu item.
- `app.version` is injected so "up to date" can say which version is running.

## Tests

`src/main/updates/UpdateService.test.ts`, with the existing fakes:

- manual check on a disabled build reports why, and never calls the updater;
- manual check with no update reports "up to date" with the version;
- manual check that finds an update reports the new version once;
- manual check that errors reports the error through the dialog;
- background check with no update stays silent (existing test kept);
- menu while ready asks first; "Later" does not quit; "Restart" requests the
  vetoable quit.

## Verification

- `npx tsc -b`
- `vitest` unit project for `src/main/updates`, system project for
  `testing/system/release`
- `npm run package:mac` once locally, then run the verify script on the real
  `release/` output: proves the new names and the feed agree on an actual build.
- Two orchestrated reviews (one round), CI green, then wait for approval.

## Not in scope

- A live old→new update run. That needs a published release: after v0.1.3 is
  out, the user checks for updates from the installed v0.1.1. No automated
  test can observe Squirrel replacing the app.
- Changing the menu label to "Restart to Update" when ready (needs a menu
  rebuild; the confirm dialog covers the safety part).
