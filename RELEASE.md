# Releasing Agent Code

How we number, time and cut releases. Read this before bumping a version or
dispatching the release workflow.

## Why this file exists

Agent Code updates itself. Every **stable** release is offered to every
installed copy (within about 4 hours, or immediately through **File → Check
for Updates…**), and applying it means restarting an app that may have live
agent sessions in it. A stable release is therefore not free: each one
interrupts every user once.

So there are exactly two kinds of release:

- **Previews** are built automatically every night. They let anyone try the
  next version early, and they are never pushed to anyone.
- **Stable releases** are always cut by hand, deliberately, and go to
  everyone.

We learned this the hard way on 2026-09-22, when v0.1.1 and v0.1.2 went out
about an hour apart, the second one only to fix a cropped modal. The rules
below exist so that releases are deliberate decisions, not side effects of
merging.

## Version numbers

Versions are `MAJOR.MINOR.PATCH` ([semver](https://semver.org)), for example
`1.4.7`. The updater compares them numerically, so they must stay valid
three-part semver. A fourth part (`1.1.1.1`) is not allowed.

| Part | Example | When | How often |
|---|---|---|---|
| **PATCH** | `0.1.2` → `0.1.3` | The normal release: a batch of fixes and features. | Most releases. |
| **MINOR** | `0.1.9` → `0.2.0` | The app changes character: a whole new capability area, or a change that breaks existing settings, data or extensions. | Rare. |
| **MAJOR** | `0.9.4` → `1.0.0` | A massive release. | Very rare. |

Rules of thumb:

- **Default to PATCH.** A big release is still a patch if it adds features
  inside what the app already is. The usage-limits feature (enablement, Grok
  and z.ai readers, the new modal) is a patch.
- **MINOR needs a reason you can say in one sentence**, like "extensions can
  now run their own services" or "settings from before this version are
  migrated and cannot be read by older builds".
- **MAJOR is the maintainer's call.** We stay on `0.x` until Julius decides
  the app is ready to be called `1.0.0`.
- A bump **resets everything to its right**: `0.1.9` → `0.2.0`, `1.5.6` →
  `2.0.0`.
- Patch numbers can go past 9: `0.1.9` → `0.1.10` is fine and normal.

## When to release

- **Batch.** Release when there is enough merged work to be worth a restart,
  or when something merged needs real users to verify it. Never release just
  because a PR merged.
- **Out-of-cycle releases are for broken releases only**: a crash on launch,
  data loss, a broken updater, or a security fix. That is the one reason to cut
  two releases close together. Everything else waits for the next batch.
- **Before releasing, land what is nearly ready.** If a reviewed, green fix is
  one merge away, merging it first is cheaper than a second release tomorrow.

## Channels

| Channel | Tag | Who gets it | Created by |
|---|---|---|---|
| **Preview** | `vX.Y.Z-preview.YYYYMMDD` (dated), plus the rolling `preview` | Only people who download it by hand. Never offered by the updater. | `.github/workflows/preview.yml`, every night from `main`, automatically. |
| **Stable** | `vX.Y.Z` | **Everyone**, through the updater. Becomes `releases/latest`, which the landing page's download button uses. | `.github/workflows/release.yml`, **by hand only**. |

**Every manual release is stable.** The release workflow has no channel
option, and it refuses a `package.json` version with a `-suffix` before it
builds anything. To let someone test a change before everyone gets it, point
them at a preview (or run the preview workflow by hand, below). Do not cut a
hand-made beta.

On GitHub, "stable" means published, not marked pre-release, and marked
**Latest**. Previews are pre-releases and never Latest. That is what keeps
them away from the landing page and the updater.

## Previews

A preview is `main`, built and signed as a preview of the **next** version.

- **Version**: the next PATCH of `package.json`, plus the UTC build date.
  After stable `0.1.3` the previews are `0.1.4-preview.20260924`,
  `0.1.4-preview.20260925`, and so on. Once `0.1.4` ships and `package.json`
  says `0.1.4`, the next night's preview becomes `0.1.5-preview.…` on its own.
- **The app knows it is a preview**: the version is stamped into the build,
  so **About** and incident reports show `0.1.4-preview.20260924`, not the
  stable version the code has already moved past.
- **Updates**: a preview install is offered the next stable release when it
  ships (`0.1.4` sorts above every `0.1.4-preview.*`), and never another
  preview.
- **Where to get one**:
  - each night's build is its own dated pre-release on the Releases page;
  - the rolling **Agent Code Preview (newest)** release always holds the
    newest one under fixed names. This link always works:
    `https://github.com/Juliusolsson05/agent-code/releases/download/preview/Agent.Code-preview-arm64.dmg`
    (`-x64.dmg` for Intel).
- **Skipped nights**: a night with no new commits on `main` builds nothing.
- **Cleanup**: dated previews older than 14 days are deleted automatically,
  and the newest 3 are always kept.
- **Timing**: scheduled for 05:00 UTC. GitHub usually starts it about 4.5
  hours late, so the preview lands mid-morning (around 10:25 UTC).

**Running one by hand** (Actions → Preview release → Run workflow, or):

```sh
gh workflow run preview.yml --repo Juliusolsson05/agent-code --ref main
```

- A manual run adds the time to the version (`0.1.4-preview.20260924.1415`),
  so it never collides with that night's build.
- Set `target=minor` while preparing a minor release, so its previews say
  `0.2.0-preview.…`.
- Set `force=true` to rebuild a commit that already has a preview.

If the next stable turns out bigger than a patch, nothing breaks: previews
labelled `0.1.4-preview.*` still sort below `0.2.0`, and their users are
offered it.

## Cutting a stable release

1. **See what is going out.**
   ```sh
   git fetch origin
   git log --oneline --first-parent v<previous>..origin/main
   ```
   If the list is thin, don't release yet.

2. **Choose the number** using the table above. Almost always PATCH.

3. **Bump the version on `main`.** `npm version` updates both `package.json`
   and `package-lock.json`; editing `package.json` by hand leaves the lockfile
   version stale.
   ```sh
   npm version 0.1.3 --no-git-tag-version
   git commit -am "chore(release): bump version to 0.1.3"
   git push origin main
   ```
   The workflow creates the tag itself, so do not tag locally.

4. **Dispatch the release workflow.** It is always stable; there is no
   channel to choose.
   ```sh
   gh workflow run release.yml --repo Juliusolsson05/agent-code --ref main \
     -f publish_release=true
   ```
   `release_tag` and `release_name` can stay empty; they are derived from
   `package.json` and a mismatch is refused. The run takes about 30–40
   minutes, most of it signing and notarization.

5. **Verify the release** once the run is green:
   ```sh
   gh release view v0.1.3 --repo Juliusolsson05/agent-code --json assets -q '[.assets[].name]'
   curl -sL https://github.com/Juliusolsson05/agent-code/releases/download/v0.1.3/latest-mac.yml | head -3
   ```
   The assets must include the `.dmg` and `.zip` for both architectures, their
   `.blockmap` files, and `latest-mac.yml`. The `curl` must work without
   logging in and must print `version: 0.1.3`. Without `latest-mac.yml` the
   updater cannot see the release.

6. **Write the release notes** (format below) with
   `gh release edit v0.1.3 --notes-file <file>`. This step is **not
   optional**: the release page is the only place anyone can see what
   changed, and v0.1.3 went out with an empty one.

## Release notes format

Same shape as the preview releases, so the Releases page reads consistently:

```markdown
built-from: <full commit sha>

Stable release of [`<short sha>`](https://github.com/Juliusolsson05/agent-code/tree/<full sha>), signed and notarized. <One or two sentences on what this release is for.>

### Highlights since v<previous>

**<Feature or fix>** — <what changes for the user, in plain words>.

### Commits since v<previous>
<output of: git log --oneline --first-parent v<previous>..v<this>>
```

Lead with what users will notice. Put caveats (things not yet verified live,
known limits) in a short note at the end rather than hiding them.

## Don't

- **Don't re-publish an older stable.** Dispatching `v0.1.0` after `v0.2.0`
  shipped makes the old one `latest` again (a known limit of
  `scripts/release/identity.mjs`). If it happens, set `latest` back on the
  Releases page.
- **Don't move a published version backwards.** The updater never downgrades
  (`allowDowngrade = false` in `src/main/updates/UpdateService.ts`), so an
  install on `0.1.3` will never be offered `0.1.2`. Fix forward with the next
  patch instead.
- **Don't delete a published stable release** once anyone besides the
  maintainer may have installed it. Their updater expects the version line to
  only go up.
- **Don't release from a branch.** Stable releases come from `main` only.
- **Don't publish a manual prerelease or beta.** Previews are the prerelease
  channel. The release workflow refuses a `-suffix` version anyway.
- **Don't edit the `preview` release or the dated previews by hand.** The
  workflow owns them: it rebuilds from the `built-from:` marker in the rolling
  release body and prunes by tag shape. To republish a preview, run the
  workflow with `force=true`.
