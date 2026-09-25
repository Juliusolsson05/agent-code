# Rewind attachment evidence (#929)

One Codex rollout in the real on-disk JSONL shape, holding the three prompt
shapes the Rewind picker has to represent.

| Row | Provenance |
|---|---|
| text + image user turn | **Recorded**, verbatim. The `payload` is copied unchanged from `testing/fixtures/image-reads/codex-user-attachment-no-detail.json`, which the image-read census captured from `~/.codex/sessions/2026/03/04/rollout-…-019cb929-….jsonl:2061`. Its base64 payload was already substituted with a 1×1 PNG by that fixture's generator — see `../image-reads/MANIFEST.md` for why that substitution is sound. |
| image-only user turn | **Derived from the same recording**, by keeping only its `input_image` part. The envelope is real; the absence of text is the case under test, and it is the one that made a turn vanish from the picker entirely. |
| reference-only user turn | **Schema-derived**, and labelled as such. `image_url` is a plain string in the Codex v2 schema (`packages/agent-transcript-parser/testing/codex-validator/schemas/codex-v2.schemas.json`), and no non-`data:` value appears in the local fixture corpus — so this is what the schema permits rather than something recorded. It exists because following such a reference would resend whatever is on disk now. |
| the session-meta and assistant rows | Envelope only, so the classifier and the resumable-prefix rule see a real conversation. |

Sanitised: `cwd`, the session id and all timestamps.

## Re-capturing

Take a fresh user attachment row from `~/.codex/sessions/**/rollout-*.jsonl`
and run it through `scripts/extract-image-fixtures.mts` first — never paste raw
base64 in here. If a real non-`data:` `image_url` ever shows up, replace the
schema-derived row with it and delete that caveat from this table.
