# release-preview fixtures

Recorded inputs for `testing/system/release/preview.test.ts`, which runs
`scripts/release/preview.mjs` (the preview workflow's logic) as a real
process. Every file is a real capture, never hand-typed. Where a test needs a
state that does not exist on GitHub yet, it derives it from these captures
with a transformation visible in the test file (`asRollingPreview`,
`withPreviews`).

This folder was `release-nightly` until the rolling nightly (#1011) became
the preview workflow on 2026-09-24. The older captures kept their names.

Captured on 2026-09-19 with the authenticated `gh` CLI:

| File | Captured with | What it proves |
|---|---|---|
| `gh-release-v0.0.2-beta.1.json` | `gh api repos/Juliusolsson05/agent-code/releases/tags/v0.0.2-beta.1` | The real release payload shape, asset names (`Agent.Code-<version>-<arch>.<ext>`, blockmaps, `latest-mac.yml`, `builder-debug.yml`) and asset `state` values, from our own signed release. |
| `gh-api-nightly-404.stdout` / `.stderr` | `gh api repos/Juliusolsson05/agent-code/releases/tags/nightly`, before any nightly existed (exit 1) | The exact "release does not exist" answer: `gh: Not Found (HTTP 404)` on stderr, with the error JSON on stdout. The response is the same for any missing tag, so it stands in for "no rolling preview yet". |
| `gh-api-401.stdout` / `.stderr` | The same call with an invalid `GH_TOKEN` (exit 1) | A real non-404 failure, which must fail the run rather than read as "no release yet". |
| `gh-release-react-latest-crlf.json` | `gh api repos/facebook/react/releases/latest` (v19.3.0) | A real body stored with CRLF line endings, as GitHub stores bodies saved through the web UI. The old inline marker parse kept the trailing `\r` and never matched. |

Captured on 2026-09-24:

| File | Captured with | What it proves |
|---|---|---|
| `gh-release-nightly-complete.json` | `gh api repos/Juliusolsson05/agent-code/releases/tags/nightly` | A real COMPLETE rolling release: `built-from:` marker first (7feda947), all four fixed-name assets `uploaded`. The tests map its asset names onto the preview names, the only difference between the two rolling releases. |
| `gh-api-releases-list.jsonl` | `gh api --paginate repos/Juliusolsson05/agent-code/releases --jq '.[] \| {tag: .tag_name, created: .created_at}'` (the exact call `prune` makes) | Every real release at the time: stables v0.1.0–v0.1.3, the `nightly` release, and the hand-cut betas. Prune must select only `nightly` from it, never a stable or a beta. |

To re-record: rerun the commands above. Once the first preview exists, also
capture `gh api repos/Juliusolsson05/agent-code/releases/tags/preview`; it can
then replace the derived rolling preview.
