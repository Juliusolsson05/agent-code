# Render-shape fixtures (Phase 3/4, PR #555)

`scripts/extract-rendering-shape.mts` writes DRAFTS here
(`<provider>/<fingerprint>/draft.json`): exact, raw, **unredacted** event windows
around a sighting, for a human/agent to curate into `final.json` /
`prefixes.json` / `expected.json` plus a catalog entry in the owning provider's
`shapes.ts`. Drafts can contain prompts, tool arguments/results, file contents,
paths, and credentials; treat them with the same care as the source recording.

Drafts are gitignored BY DESIGN. Only separately curated fixtures, reviewed
line by line and checked for sensitive content, may be committed. Do not
force-add or merely rename `draft.json`: renaming preserves the raw bytes and
is not curation or redaction.

Shape fixtures pin one provider parser + component grammar; recording
fixtures (../rendering-recordings) replay multi-event ownership over time.
Neither replaces the other (plan §Step 7).
