# Nightly Release Workflow Plan

**Issue:** #1011. **Branch:** `feat/nightly-release`, based on `origin/main` @ `f61c7a15`.

## Goal

`main` produces a rolling, signed, notarized **`nightly`** GitHub Release with
**fixed-name assets** whenever it has commits the previous nightly did not
build — with zero manual dispatch — while the versioned `release.yml` path
stays byte-for-byte untouched.

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
   Skip logic: fetch the `nightly` release, extract the marker, compare with
   `origin/main`; equal ⇒ skip (exit success with a visible message — a
   scheduled run that does nothing must look like success, not like a
   failure).

4. **Non-prerelease, `make_latest: true`.** `releases/latest` (which the
   landing page consumes) only returns non-prereleases; marking the nightly
   as one makes the site's download buttons resolve real builds immediately
   during the beta phase. A future stable versioned release outranks it by
   creation date (`releases/latest` sorts by created_at, and asset
   replacement does not bump it) — but when the first stable ships, the
   owner should still revisit whether the nightly keeps `make_latest` (noted
   in #1011).

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

6. **Concurrency group `release-macos`.** The nightly joins the versioned
   release's existing group (not a new one) so a nightly and a manual release
   can never package or publish at the same time; `cancel-in-progress:
   false` queues rather than kills, because killing a 26-minute macOS
   packaging run mid-notarization wastes the run and leaves no evidence.

7. **Secrets validated before anything expensive.** The nightly always
   publishes, so the five signing/notarization secrets are mandatory; the
   check runs in the first job, before the change-check even, so a
   secret-less fork fails in seconds, not after a 9-minute build.

## Files

| File | Role |
|---|---|
| `.github/workflows/reusable-app-build-macos.yml` | `workflow_call`: build-app + package-macos, verbatim extraction from `release.yml` minus release creation |
| `.github/workflows/nightly.yml` | schedule (05:00 UTC) + dispatch: validate secrets → skip-check → build (reusable) → publish fixed-name rolling `nightly` release |
| this plan | decisions + verification record |

## Verification

- `actionlint` over both new workflow files (syntax, expression contexts,
  reusable-workflow wiring).
- Real end-to-end: `gh workflow run nightly.yml --ref feat/nightly-release`
  — dispatch works from a branch, the reusable reference resolves, and the
  first run publishes the `nightly` release with fixed-name assets. This is
  the intended production behavior, so it is run for real, not dry.
- A second dispatch with no new `main` commits must skip visibly.
- `release.yml` untouched: `git diff origin/main -- .github/workflows/release.yml` is empty.

## Out of scope

- Switching `release.yml` to the reusable jobs (follow-up after first green nightly).
- Landing-page changes (none needed — suffix match already resolves the fixed names).
- Auto-update channel design.
