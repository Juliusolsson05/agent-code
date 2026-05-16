# Upstream version support

`upstream-versions.json` records the Claude Code / Codex CLI versions
this repo has **explicitly accepted as supported** — meaning a human or
agent has reviewed the upstream release and confirmed this repo still
works against it.

## How drift is detected

`.github/workflows/upstream-watch.yml` runs daily. It calls
`scripts/check-upstream.mjs`, which fetches npm's `latest` dist-tag for
each package and compares it to `accepted`. If `latest` is newer, the
workflow opens (or updates) one rolling maintenance issue per provider.

The automation **only detects drift**. It never reads changelogs,
guesses what broke, or edits this file. An open drift issue does not
imply a known breakage — it only means upstream moved.

## How to accept a new version

1. Read the upstream release notes linked in the drift issue.
2. Work through the issue's acceptance checklist (runtime smoke test,
   transcript/session paths, parsers, fixtures).
3. If the transcript or rollout JSONL shape changed, file an issue in
   `agent-transcript-parser`.
4. Bump `accepted` (and `checkedAt`) for that provider in a PR.
5. On the next run the bot sees no drift and closes the issue.

Bumping `accepted` is a deliberate human act. Do not bump it to silence
the bot without doing the review.
