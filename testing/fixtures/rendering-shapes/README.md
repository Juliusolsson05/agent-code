# Render-shape fixtures (Phase 3/4, PR #555)

`scripts/extract-rendering-shape.mts` writes DRAFTS here
(`<provider>/<fingerprint>/draft.json`): redacted event windows around a
sighting, for a human/agent to curate into `final.json` / `prefixes.json` /
`expected.json` plus a catalog entry in the owning provider's `shapes.ts`.

Drafts are gitignored BY DESIGN — even structure-only redaction keeps
`file` values, and the sensitive-survivor gate only proves key-named
secrets are gone. Only CURATED fixtures (reviewed line by line) get
committed, by force-adding or renaming away from `draft.json`.

Shape fixtures pin one provider parser + component grammar; recording
fixtures (../rendering-recordings) replay multi-event ownership over time.
Neither replaces the other (plan §Step 7).
