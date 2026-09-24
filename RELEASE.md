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
| **Preview** | `vX.Y.Z-preview.YYYYMMDD` (dated), plus the rolling `preview` | People who choose **Settings → Workspace → Update channel → Preview**, through the updater, and anyone who downloads one by hand. | `.github/workflows/preview.yml`, every night from `main`, automatically. |
| **Stable** | `vX.Y.Z` | **Everyone else**, through the updater. Becomes `releases/latest`, which the landing page's download button uses. | `.github/workflows/release.yml`, **by hand only**. |

**Every manual release is stable.** The release workflow has no channel
option, and it refuses a `package.json` version with a `-suffix` before it
builds anything. To let someone test a change before everyone gets it, point
them at a preview (or run the preview workflow by hand, below). Do not cut a
hand-made beta.

On GitHub, "stable" means published, not marked pre-release, and marked
**Latest**. Previews are pre-releases and never Latest. That is what keeps
them away from the landing page and from the updater on the Stable channel.

## Previews

A preview is `main`, built and signed as a preview of the **next** version.

- **Version**: the next PATCH of `package.json`, plus the UTC build date.
  After stable `0.1.3` the previews are `0.1.4-preview.20260924`,
  `0.1.4-preview.20260925`, and so on. Once `0.1.4` ships and `package.json`
  says `0.1.4`, the next night's preview becomes `0.1.5-preview.…` on its own.
- **The app knows it is a preview**: the version is stamped into the build,
  so **About** and incident reports show `0.1.4-preview.20260924`, not the
  stable version the code has already moved past.
- **Getting previews through the updater (#1168)**: choose **Update
  channel → Preview** in Settings → Workspace.
  - **File → Check for Updates…** and the background checks then offer each
    night's preview when it is newer than the running app. They read
    `preview-mac.yml` on the rolling release.
  - A preview installed by hand is on the Preview channel by default.
  - Preview updates always download in full, because the rolling files have
    fixed names, so differential download cannot work.
  - When a stable release ships, Preview users get the next night's preview,
    which contains it, not the stable build itself.
- **Leaving Preview**: switching back to Stable never downgrades.
  - The app stays on its preview until the next stable passes it: `0.1.4` sorts
    above every `0.1.4-preview.*`, so 0.1.4 is offered when it ships.
  - An update already found or downloaded on the old channel is dropped.
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

- Manual runs build `main` only. A run from any other branch is refused,
  because it would replace the "newest preview" download with an unreviewed
  branch build.
- A manual run adds the time to the version (`0.1.4-preview.20260924.1415`),
  so it never collides with that night's build.
- `target=minor` builds ONE preview labelled for the next minor
  (`0.2.0-preview.…`), even if `main` has not moved since the last preview.
  Scheduled nights keep previewing the next patch, so run it again whenever
  you want a fresh minor-labelled build.
- `force=true` rebuilds a commit that already has a preview.
- To retry a failed preview, start a **new** run. "Re-run all jobs" on an
  older run is refused once a newer dated preview exists: it would put the
  old commit's build under today's date.

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

## Writing the release notes

Every stable release gets notes before you tell anyone about it. The release
page is the only place a user can see what changed, and v0.1.3 went out with
an empty one.

### Who reads them

People who use Agent Code, deciding whether to restart for the update and
what to try afterwards. They do not know the codebase, the PR numbers or the
internal names. Write for them, not for the team.

### Gather what shipped

```sh
git log --oneline --first-parent v<previous>..origin/main
```

Every line is a merged PR. Read each PR's title and description
(`gh pr view <number> --repo Juliusolsson05/agent-code`), then sort it:

- **Users will notice it**: a new feature, a changed behaviour, or a fixed bug
  someone could have hit. It goes in the notes.
- **Users will not notice it**: refactors, tests, CI, docs, internal tooling,
  dependency bumps with no visible effect. Leave it out of the highlights. It
  still appears in the commit list at the bottom.
- **Security fixes and fixes for crashes or data loss** always go in, even
  when small, under **Fixed**.

### What to write

1. **Opening sentence**: what this release is about, in one or two sentences.
   Name the biggest change. If there is anything the user must do, say it
   here (for example: sign in again, re-enable a setting, restart agents).
2. **Highlights**, grouped under **New**, **Improved** and **Fixed**, most
   important first. Drop a group that has nothing in it. One bullet per
   change:
   - start with the **thing** in bold, as it appears in the app (the menu
     item, command or setting name);
   - then say **what changes for the user**, in plain words: what they can
     do now, or what no longer goes wrong;
   - add where to find it if it is new ("Settings → Skills", "the Add Skill…
     command");
   - one or two sentences, no implementation details, no internal names.
3. **Before you update** (only when it applies): anything that could surprise
   someone, such as a changed default, a migration older builds cannot read,
   or a feature removed.
4. **Known issues** (only when it applies): what is not working yet or not
   verified live, and the workaround. Say it plainly rather than leaving it
   out.
5. **Commits since v<previous>**: the `git log` output above, unedited.

### Style

- Plain language, present tense, second person ("You can now…").
- Say what the user sees, not how it was built. "Agents launched from Agent
  Code can now use your own MCP servers", not "added launch-time `--mcp-config`
  injection".
- No PR or issue numbers in the highlights; the commit list carries them.
- Don't oversell. "Faster" needs to be true in normal use; "fixed" means
  verified fixed.

### Template

```markdown
built-from: <full commit sha>

Agent Code <version>, built from [`<short sha>`](https://github.com/Juliusolsson05/agent-code/tree/<full sha>), signed and notarized. <One or two sentences: what this release is about, and anything the user must do.>

### New
- **<Name as shown in the app>** — <what the user can do now>. <Where to find it.>

### Improved
- **<Name>** — <what is better, in the user's terms>.

### Fixed
- **<Name>** — <what no longer goes wrong>.

### Before you update
- <Only if needed.>

### Known issues
- <Only if needed, with the workaround.>

### Commits since v<previous>
<output of: git log --oneline --first-parent v<previous>..v<this>>
```

### Example

These are the notes v0.1.3 should have had, written from its real merges
(v0.1.2..v0.1.3). The extension refactor, the incident-journal change and the
proxy identity fix are internal, so they appear only in the commit list:

```markdown
Agent Code 0.1.3 lets you add your own MCP servers, gives agents a browser they can drive, adds Pi as an agent provider, and shows usage limits for more providers.

### New
- **Your own MCP servers** — add any MCP server by pasting the config from its README, choose which providers and which agents get it, and keep its tokens encrypted. Settings → MCP, or the Add MCP Server… command.
- **Browser pocket** — each agent can open a browser beside it and drive it to check the page it is working on.
- **Pi** — Pi is now available as an agent provider, in its own terminal.
- **Usage limits** — choose which providers Agent Code shows, and see Grok and z.ai usage alongside the others in the Usage window.
- **Extensions** — extensions can now call the web services they declare and keep their own secrets.

### Improved
- **Agent Management** — agents can now be targeted by the label you see beside them (such as B28) or by their spoken name.

### Fixed
- **Updates** — downloading an update now works, and Check for Updates always gives an answer.
- **Agents with a broken skill** — an agent now starts without the broken skill instead of not starting at all.
- **Orchestration** — sending a prompt to a child agent that is still starting now waits for it instead of failing.

### Commits since v0.1.2
<git log --oneline --first-parent v0.1.2..v0.1.3>
```

### Checklist before publishing the notes

- [ ] Every user-visible change is in, and nothing internal is in the highlights.
- [ ] Every name matches what the app shows.
- [ ] Anything the user must do is in the opening sentence.
- [ ] Known issues are listed, not hidden.
- [ ] The commit list is complete.

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
- **Don't release from a branch.** Stable and preview releases come from `main` only.
- **Don't publish a stable release without notes.** Write them before
  announcing it (see "Writing the release notes").
- **Don't publish a manual prerelease or beta.** Previews are the prerelease
  channel. The release workflow refuses a `-suffix` version anyway.
- **Don't edit the `preview` release or the dated previews by hand.** The
  workflow owns them: it rebuilds from the `built-from:` marker in the rolling
  release body and prunes by tag shape. To republish a preview, run the
  workflow with `force=true`.
