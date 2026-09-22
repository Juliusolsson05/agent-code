# Releasing Agent Code

How we number, time and cut releases. Read this before bumping a version or
dispatching the release workflow.

## Why this file exists

Agent Code updates itself. Every **stable** release is offered to every
installed copy (within about 4 hours, or immediately through **File → Check
for Updates…**), and applying it means restarting an app that may have live
agent sessions in it. A release is therefore not free: each one interrupts
every user once.

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
| **Nightly** | `nightly` (rolling) | Only people who download it by hand. Never offered by the updater. | `.github/workflows/nightly.yml`, daily at 05:00 UTC from `main`. |
| **Prerelease** | `vX.Y.Z-beta.N` | Only people who download it by hand. Never becomes "latest", never offered by the updater. | Release workflow, `channel=prerelease`. |
| **Stable** | `vX.Y.Z` | **Everyone**, through the updater. Becomes `releases/latest`, which the landing page's download button uses. | Release workflow, `channel=stable`. |

Use a prerelease when something needs testing on a real install before
everyone gets it. Its version must be a prerelease of the **next** version
(`0.1.3-beta.1` after `0.1.2`); `0.1.2-beta.1` would sort as older than
`0.1.2`. The workflow refuses the wrong combination before it builds.

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

4. **Dispatch the release workflow.**
   ```sh
   gh workflow run release.yml --repo Juliusolsson05/agent-code --ref main \
     -f publish_release=true -f channel=stable
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
   `gh release edit v0.1.3 --notes-file <file>`.

## Release notes format

Same shape as the nightly, so the Releases page reads consistently:

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
