# Preview update channel — design

Status: user-approved 2026-09-24 · Branch: `feat/preview-update-channel` ·
Issue: #1168 · Builds on: #1128 (nightly previews, stable-only manual
releases, RELEASE.md), #1120/#1131 (self-update), #1129 (feed names must
match uploaded names).

## What the user asked for

- "Will Check for Updates not install the preview? Maybe we have a second
  option inside Agent Code, something like check for preview versions."
- They approved a setting rather than a second menu item: **Update channel:
  Stable / Preview**. The existing **Check for Updates…** follows it.
- "Build this out for me following the agent code conventions."

## Evidence

### Today

- `UpdateService` forces `allowPrerelease = false` (#1128). The packaged app's
  `app-update.yml` says `provider: github`, and the GitHub provider with
  prereleases off reads `releases/latest`, which is always the newest stable.
  Previews are never offered.
- Preview builds (`preview.yml`):
  - They are published as a DATED prerelease (`v0.1.4-preview.20260924`,
    versioned asset names) and as the ROLLING `preview` release
    (`Agent.Code-preview-<arch>.dmg|zip`).
  - `preview.mjs rename` deletes the update metadata: every `*.yml` and
    `*.blockmap`.

### electron-updater 6.6 (read in `node_modules/electron-updater/out`)

1. **`AppUpdater.channel` is a trap.**
   - Its setter sets `allowDowngrade = true` as a side effect.
   - Once it has a value, it refuses a non-string, so it cannot be set back to
     "no channel". Switching back to stable would therefore be impossible in
     the same session.
2. **The GitHub provider's prerelease walk is fragile for our releases.**
   - With `allowPrerelease` on and a stable running version, it takes the
     FIRST entry of the releases Atom feed, which could be the rolling
     `preview` release (not a semver tag).
   - With a channel, it walks the feed for a tag whose prerelease id matches.
     After a stable ships, a preview user whose next preview is not out yet
     finds only older previews, and gets nothing.
   - In both modes, which release gets picked depends on how GitHub orders
     its feed.
3. **`setFeedURL(options)` replaces the provider at runtime** (it sets
   `clientPromise`), so a channel switch needs no restart.
4. **The generic provider reads `${url}/${channel}${-mac}.yml`.** On macOS,
   `channel: 'preview'` gives `preview-mac.yml`. It resolves the files the
   feed names against the same base URL.
5. **Differential download finds the old blockmap by substituting versions
   into the file URL** (`util.blockmapFiles`). With fixed, version-less names
   the "old" and "new" blockmap URLs are identical, so the differential
   downloader would diff the new build against itself.
   `disableDifferentialDownload` exists and forces a full download.

### electron-builder

For `provider: github`, electron-builder never writes a version-derived
channel into `app-update.yml`, and `computeChannelNames` returns `latest`. So
a preview build still produces `latest-mac.yml`, listing its versioned file
names with sha512 and size (the real v0.1.3 feed is recorded in the tests).

## Decisions

### D1. Preview updates come from the rolling release, through the generic provider

- **Preview channel:**
  `setFeedURL({ provider: 'generic', url: 'https://github.com/Juliusolsson05/agent-code/releases/download/preview/', channel: 'preview' })`,
  plus `disableDifferentialDownload = true`.
- **Stable channel:**
  `setFeedURL({ provider: 'github', owner: 'Juliusolsson05', repo: 'agent-code' })`,
  with differential download allowed. These are the same values as
  `electron-builder.yml`'s `publish` block, which is today's behaviour.

Why:
- **Deterministic.** The rolling release always holds the newest preview, so
  there is no feed walk.
- **Restart-free and reversible.** Switching is just `setFeedURL`.
- **Safe.** `allowPrerelease` and `allowDowngrade` stay off, and the
  `channel` property is never set.

### D2. The rolling release publishes `preview-mac.yml`, and the dated ones stay download-only

`preview.mjs rename` builds the feed from electron-builder's generated feed
(exactly one `*-mac.yml`):
- every `url`, and the top-level `path`, is rewritten from its versioned name
  to the rolling name (`Agent-Code-<version>-<arch>.<ext>` →
  `Agent.Code-preview-<arch>.<ext>`);
- the version, sha512 and sizes stay unchanged, because they describe the
  same bytes.

The result is `preview-mac.yml`:
- `verify-update-feed.mjs` (#1129) checks it against the files about to be
  uploaded, extended to take the feed name as an argument;
- the workflow uploads it LAST, so a feed never names files whose uploads
  have not finished.

Blockmaps are not published (D1 turns differential download off). The dated
releases stay download-only; nothing reads a feed there.

**Accepted window:** while the rolling release republishes, each asset is
briefly deleted and re-uploaded, and the old `preview-mac.yml` stays until the
new one lands. A check during those minutes can fetch a file whose sha512
does not match yet. electron-updater verifies sha512 and reports an error, so
nothing wrong is installed; the next check (4 h, or a menu click) succeeds.

### D3. Where the channel lives, and its default

- **Main owns it.** It is stored beside the check clock in the existing
  `updates.json` (`UpdateCheckStore`): main needs it before any window exists
  (the first check runs 3 minutes after launch), so it cannot live in the
  renderer's localStorage settings.
- **Default:** Stable, **unless the running app is itself a preview build**
  (its version contains `-preview.`). Someone who installed a preview by hand
  keeps getting previews, instead of sitting on a preview version that only
  the next stable release can replace.
- **The stored choice always wins** over the default.

### D4. Switching channel

`UpdateService.setChannel(channel)`:
1. persists the choice;
2. re-points the feed;
3. drops any update found, downloading or ready from the OTHER channel
   (state back to idle; the restart intent is cleared), because installing a
   preview after the user chose Stable, or the reverse, would contradict the
   choice;
4. starts a forced background check on the new channel.

**Switching Preview → Stable never downgrades.** `allowDowngrade` stays off,
so a `0.1.4-preview.*` install is offered `0.1.4` stable when it ships, which
semver orders above every `0.1.4-preview.*`, and nothing before then.

### D5. What the user sees

- **Settings → Workspace → Update channel:**
  - Stable ("tested releases, recommended");
  - Preview ("tonight's build of the next version; may have bugs").
  - The row also shows the running version.
- **Check for Updates… messages name the channel when it is Preview.** For
  example: "You're up to date on the Preview channel. Agent Code
  0.1.4-preview.20260924 is the newest preview."
- **The menu label stays "Check for Updates…".** `appMenu.ts` already
  documents why the static menu is not rebuilt on updater events: doing so
  briefly detaches every accelerator.

### D6. Preview channel behaviour to document (RELEASE.md)

- **Nightly updates:** preview users are offered each night's preview when it
  is newer than what they run.
- **When a stable ships:** preview users get the next night's preview, which
  contains it, not the stable itself. The preview feed only knows the rolling
  preview.
- **Updates are full downloads,** not differential ones.

## Out of scope

- Windows and Linux feeds: the app ships macOS only.
- Showing release notes in the update dialog.
