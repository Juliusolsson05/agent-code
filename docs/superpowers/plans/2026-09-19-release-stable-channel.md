# Release workflow: a stable channel

Stage 8 of `docs/decomposition/release-readiness.md`, first item.

## A: what exists

`.github/workflows/release.yml` builds, signs, notarizes and verifies the macOS app, then creates a GitHub Release. The release step hardcodes `prerelease: true` and sets no `make_latest`. The dispatch inputs default to `v0.0.2-beta.1` / "Agent Code 0.0.2 Beta 1", the release that already exists.

The only identity check is inline bash in `validate-release`, which nothing can test: "tag must equal `v` + package.json version".

On GitHub, every existing release is a prerelease and none is marked latest (`gh release list`, 2026-09-19). So `releases/latest` 404s, and so does the landing page's stable download button.

## D: the end state

- One dispatch input, `channel`, chooses `prerelease` (the default, what every past release was) or `stable`.
- A stable release is created with `prerelease: false` and `make_latest: true`, so `releases/latest` resolves to it.
- A prerelease is created exactly as before: `prerelease: true`, never latest.
- The tag and name default from package.json, so the next release is not dispatched with last release's stale defaults.
- The rules that keep a channel honest are enforced before a 26-minute build starts:
  - a stable channel needs a version without a prerelease suffix;
  - a prerelease channel needs one;
  - the tag must equal `v` + version.

## Stages

1. **Identity rules as a script.**
   - **Produces:** `scripts/release/identity.mjs`. It reads the channel and the optional tag and name inputs, plus the version in package.json, and it writes `tag`, `name`, `prerelease` and `make_latest` to `GITHUB_OUTPUT`, or exits 1 with the reason.
   - **Verified by:** `testing/system/release/identity.test.ts`. It runs the script as a real process, the same way the workflow does, on the real recorded versions (`0.0.2-beta.1`, the published beta) and the planned stable `0.1.0`. It is written before the script.
   - **Why separate:** the rules decide whether a signed build becomes `latest` for every user. Inline YAML is how nightly.mjs's three defects went unnoticed (#1012).
2. **The workflow calls it.**
   - **Produces:** `validate-release` exposes the script's outputs as job outputs. `package-macos` creates the release from them.
   - **Verified by:** YAML review, and an `actionlint`-style read that every `needs.*.outputs` reference exists. The first real stable dispatch is Stage 8's last step.

## Unknowns

- Whether the owner wants `0.1.0` (the ledger default) or another number. The script does not care; the bump is a separate change.
- `softprops/action-gh-release` pinned at `efb35369`: `make_latest` accepts the strings `"true"`, `"false"` and `"legacy"`. The script emits strings.
