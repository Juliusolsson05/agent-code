# Conversation corpus

Recorded by `scripts/extract-conversation-corpus.mts` from the author's real
provider stores (Claude Code 2.1.x transcripts and `history.jsonl`, Codex
0.154 `state_5.sqlite` and rollouts, OpenCode 1.18 `opencode.db`) on the date
in `manifest.json`. Purpose: the case set for `src/main/conversations`.

Redaction: every string outside the allowlist in
`scripts/conversation-corpus-policy.ts` is replaced by `p:<sha8>:<len>`;
wrapper prefixes the catalog keys on are kept verbatim; paths are rewritten to
`/fixture/repo`, `/fixture/home`, `/fixture/other-N`; branches other than
`main` hash. The unredacted mirror lives in `local/` (git-ignored) for the
live suite.

`expectations.json` is hand-authored with the user: the kinds, label sources
and default order the catalog must reproduce. It is not derived from the
implementation.

Regenerate: `UPDATE_FIXTURES=1 npm run extract:conversations`. Verify:
`npm run check:conversation-fixtures`.
