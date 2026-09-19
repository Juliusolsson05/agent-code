# Nightly Release Workflow Plan

**Issue:** #1011. **Branch:** `feat/nightly-release`, based on `origin/main` @ `f61c7a15`.

## Goal

`main` produces a rolling, signed, notarized **`nightly`** GitHub Release with
**fixed-name assets** whenever it has commits the previous nightly did not
build — with zero manual dispatch — while the versioned `release.yml` path
changes by one comment only (a drift pointer).

## Design decisions (the WHY, settled before the YAML)

1. **Rolling release, not versioned tags.** The nightly's purpose is a stable
   URL, not a stable artifact: the landing page links and any hand-shared URL
   must survive every build, so the release identity (`tag: nightly`) and the
   asset names are constants and the CONTENTS roll. Version identity already
   exists in the versioned release path; duplicating it per nightly would
   recreate exactly the link-rot this issue exists to remove.

2. **Fixed names: `Agent.Code-nightly-<arch>.dmg` / `.zip`.** The landing page
   resolves download links by `-<arch>.dmg` suffix match, so these names plug
   in with no site change. Blockmaps and `latest-mac.yml` are deliberately
   NOT shipped on the nightly: they are electron-builder auto-updater
   metadata referencing the *versioned* filenames, the app has no auto-update
   channel, and keeping them would either break the updater contract or
   reintroduce version-bearing names.

3. **Skip state lives in the release body (`built-from: <sha>`), not a tag.**
   A `nightly` tag cannot move without force-pushing a published tag, which
   is hostile to anyone who pinned it. The body marker is authoritative,
   trivially parseable with `gh api --jq`, and survives asset replacement.
   Skip logic (in `scripts/release/nightly.mjs decide`): fetch the `nightly`
   release, extract the marker, and compare it with the SHA the run was
   triggered for (`GITHUB_SHA`; for a scheduled run that is main's HEAD).
   Skip only when the SHAs are equal AND all four fixed assets are present
   and `uploaded`. A skip exits successfully with a visible message.
   **Revised after the PR review:**
   - The marker is written LAST, by a `gh release edit` after softprops has
     uploaded every asset, so a failed publish leaves no marker for its SHA.
   - The parse is CRLF-safe and exact-40-hex, because bodies edited in the
     web UI come back with CRLF.
   - Only a 404 means "no nightly yet"; any other API error fails the run.
   - A `force` dispatch input rebuilds regardless.

4. **PRERELEASE, `make_latest: false`** (revised after the PR review). The
   first draft made the nightly a non-prerelease with `make_latest: true`, on
   the claim that a later stable release would outrank it by creation date.
   **That was false.** softprops sends `make_latest` on EVERY update, and an
   explicit `true` overrides date ordering, so each nightly would take
   "latest" back from a stable release. The goal is a stable production
   release, so the stable versioned release owns `releases/latest`, which the
   landing page resolves, and the nightly is a prerelease. Until the first
   stable exists, the site's buttons fall back to the Releases page, which
   is by design.

5. **Shared pipeline via a new reusable workflow, extracted VERBATIM from
   `release.yml`.** The heavy middle — submodule auth, tests, audit gate,
   runtime preparation, tar handoff, signed packaging, verification, smoke —
   is copied without edits into
   `.github/workflows/reusable-app-build-macos.yml`, minus the
   versioned-release creation step (the caller publishes). `release.yml`
   itself is NOT switched to the reusable jobs in this PR: that pipeline is
   proven end-to-end (runs 35277382769, 35290131682), and rewriting it in
   the same change as a brand-new trigger would entangle a regression in the
   known-good path with the new one. Adopting the reusable jobs in
   `release.yml` is the follow-up once a nightly has run green; until then
   the plan doc and the reusable workflow's header carry a drift warning
   pointing at the mirror.

6. **Its own concurrency group, `release-nightly`** (revised after the PR
   review). The first draft joined `release.yml`'s `release-macos` group and
   claimed it "queues, never cancels". That is false: GitHub keeps ONE pending
   run per group, and a newer pending run cancels the older pending one, so a
   scheduled nightly could cancel a queued manual release. The two publish to
   different releases, so they can safely run side by side. Within
   `release-nightly`, the newest pending nightly replacing an older pending
   one is the desired behaviour. `cancel-in-progress: false` still protects a
   running, notarizing job.

7. **Secrets validated before anything expensive.** The nightly always
   publishes, so the five signing/notarization secrets are mandatory; the
   check runs in the first job, before the change-check even, so a
   secret-less fork fails in seconds, not after a 9-minute build.


8. **The logic lives in a tested script, not inline YAML** (added after the
   PR review). The review found three real bugs in the inline bash: the CRLF
   marker, an unreachable previous SHA crashing `git log` after a full build,
   and the marker being written before the uploads. None of them could be
   tested while inline. `scripts/release/nightly.mjs` (`decide` / `rename` /
   `notes`, Node built-ins only) is now the single implementation.
   `testing/system/release/nightly.test.ts` runs it as a real process: a stub
   `gh` replays RECORDED GitHub payloads (`testing/fixtures/release-nightly`,
   provenance in its README), notes run against a real git repo, and rename
   runs on the real v0.0.2-beta.1 artifact names.

9. **Accepted trade-offs, stated honestly:**
   - softprops deletes and re-uploads each asset, so a page loaded just
     before a publish can 404 once. A fresh page load falls back to the
     Releases page.
   - The `nightly` tag and the "Source code" archives stay at the FIRST
     nightly's commit, because moving a published tag breaks pins. The body
     links the exact tree of each build. `target_commitish` makes that first
     tag land on the built commit, not on the default branch HEAD at publish
     time.
   - Nightlies report the same app version as the last release. Version
     stamping is a follow-up.

## Files

| File | Role |
|---|---|
| `.github/workflows/reusable-app-build-macos.yml` | `workflow_call`: build-app + package-macos, verbatim extraction from `release.yml` minus release creation |
| `.github/workflows/nightly.yml` | schedule (05:00 UTC) + dispatch (`force` input): validate secrets → skip-check → build (reusable) → publish the fixed-name rolling `nightly` prerelease → record the marker |
| `scripts/release/nightly.mjs` | the workflow's logic: `decide`, `rename`, `notes` |
| `testing/system/release/nightly.test.ts` + `testing/fixtures/release-nightly/` | system tests against recorded GitHub payloads and a real git repo |
| this plan | decisions + verification record |

## Verification

- `actionlint` over both new workflow files (syntax, expression contexts,
  reusable-workflow wiring).
- `testing/system/release/nightly.test.ts`: 16 cases, written before the
  script and all failing first.
- Real end-to-end AFTER merge. `workflow_dispatch` only runs workflow files
  that exist on the default branch, so a pre-merge dispatch from this branch
  returns 404; the first draft of this plan was wrong about that. The check
  is `gh workflow run nightly.yml` on main: the first run publishes the
  `nightly` prerelease with the four fixed-name assets.
- A second dispatch with no new `main` commits must skip visibly.
- A THIRD run exercises the rolling update path, which the first two never
  touch (verification review): `gh workflow run nightly.yml -f force=true`,
  or a run after a new commit on main. Check that:
  - all four asset IDs changed and every asset is `uploaded`;
  - the marker shows the new SHA;
  - the release is still a prerelease;
  - `releases/latest` is unchanged.
  Watch for softprops#411: `target_commitish` against an older commit can 403
  with `github.token`. That fails loudly, and a retry is safe.
- "latest" is owned by nobody until `release.yml` can publish a NON-prerelease
  (it hardcodes `prerelease: true`). That is release-readiness Stage 8, and
  until then the landing page stays on its Releases-page fallback, by design.
- `release.yml` changes by one comment only: a drift pointer to the
  reusable mirror.

## Out of scope

- Switching `release.yml` to the reusable jobs (follow-up after first green nightly).
- Landing-page changes. The suffix match resolves the fixed names. The stale
  "only an April prerelease" comment in `site.ts`, and a status line for
  stable vs. nightly, are handled in the release stage of
  docs/decomposition/release-readiness.md.
- Auto-update channel design.
