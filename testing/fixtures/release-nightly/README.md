# release-nightly fixtures

Recorded inputs for `testing/system/release/nightly.test.ts`, which runs
`scripts/release/nightly.mjs` (the nightly workflow's logic) as a real
process. Every file is a real capture, never hand-typed. Where a test needs a
state that does not exist on GitHub yet, it derives it from these captures
with a transformation visible in the test file (`asCompleteNightly`).

All captured on 2026-09-19 with the authenticated `gh` CLI:

| File | Captured with | What it proves |
|---|---|---|
| `gh-release-v0.0.2-beta.1.json` | `gh api repos/Juliusolsson05/agent-code/releases/tags/v0.0.2-beta.1` | The real release payload shape, asset names (`Agent.Code-<version>-<arch>.<ext>`, blockmaps, `latest-mac.yml`, `builder-debug.yml`) and asset `state` values, from our own signed release. |
| `gh-api-nightly-404.stdout` / `.stderr` | `gh api repos/Juliusolsson05/agent-code/releases/tags/nightly`, before any nightly existed (exit 1) | The exact "no nightly yet" answer: `gh: Not Found (HTTP 404)` on stderr, with the error JSON on stdout. |
| `gh-api-401.stdout` / `.stderr` | The same call with an invalid `GH_TOKEN` (exit 1) | A real non-404 failure, which must fail the run rather than read as "no nightly". |
| `gh-release-react-latest-crlf.json` | `gh api repos/facebook/react/releases/latest` (v19.3.0) | A real body stored with CRLF line endings, as GitHub stores bodies saved through the web UI. 5 of the last 5 releases of facebook/react and denoland/deno had CRLF. The old inline marker parse kept the trailing `\r` and never matched. |

To re-record: rerun the commands above. Once the first real nightly exists,
also capture `gh api repos/Juliusolsson05/agent-code/releases/tags/nightly`.
It can then replace the derived "complete nightly" case.
