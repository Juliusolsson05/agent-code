# One invalid TLDR/Goal record must not break TLDR and Goal for every agent (#1247)

## Verified failure
On the owner's real `tldr.json` (328 records, one exactly at today's 400-char limit), one character added to that record makes every `TldrStore` read and write throw. The thrown error is `TLDR must contain 1–400 characters.`: the validator `normalizeTldrText` throws rather than returning false, so the failure escapes the per-record check entirely. `records` is never cached, so every call re-fails. The Goal store shares the class.

The same happens for a half-written completion (a `completedAt` without its note), via `validCompletion`.

## Design
- **Invalid record:** set aside per identity. It is not repaired or guessed; that identity simply has no current record and can report again.
- **Preserved bytes:** the original file is copied to `<file>.invalid-<sha256 prefix>.json` before any write can drop the record. It is named by digest so relaunching over the same bytes adds no copies.
- **Malformed container** (version, or records not an object): still refuses, because a write through it would destroy every record.
- **Validation no longer throws:** stored text is validated with a non-throwing check. It is also used for the completion note and history entries, so an over-limit history entry reports "history is invalid" instead of a misleading length error.

## Tests
Real records (texts redacted to same-length markers) in `testing/fixtures/tldr-store/`:
- over-limit TLDR;
- half-written goal completion;
- no duplicate copies across launches;
- the container still refuses.

The old "refuse the whole file" test becomes "set aside and preserve". All are red on main where applicable, and each change is mutation-checked.
