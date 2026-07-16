# Fixtures

Small, redacted fixtures live here when a test case is shared by multiple
modules or is too large to keep inline.

Prefer fixture builders in `testing/support/builders/` for ordinary object
setup. Use committed fixtures only when the literal shape matters, such as a
provider transcript edge case or a reduced debug bundle.

## Rendering fixture families

- `rendering-bundles/` are reduced snapshots of real, saved debug bundles.
  They protect ledger ownership and ordering against the rows the old renderer
  actually painted.
- `rendering-recordings/` are redacted channel streams replayed through the
  current ledger. Their golden output is intentionally self-blessed.
- `debug-bundles/` contains tiny, hand-authored bundle inputs used to verify the
  extraction tooling itself. These are not added to the 48-bundle ownership
  corpus.
- `feed-presentation/` contains provider-shaped operation evidence for the
  post-ledger presentation layer. It is intentionally about user-visible
  operation families, not transcript ownership.

The distinction matters. A final `tool_use` object proves what happened after
the provider finished its arguments; it does not prove what the UI could have
known while those arguments were streaming. New bundle fixtures may therefore
carry optional `input.liveToolInputPrefixes` evidence. The extractor samples
only classifier-relevant milestones per operation:

1. the first cumulative prefix;
2. the first quoted `*** Begin Patch` declaration;
3. the first appearance of each `tools.<operation>(...)` invocation;
4. the latest prefix, when it is not already one of the above.

This bounded sequence exists because a recent Codex bundle contained hundreds
of cumulative `tool_input_delta` records. Copying all of them makes a fixture
unreviewable; keeping only the final one reproduces the original rendering bug,
where users saw raw generated JavaScript until the completed patch object
arrived. Presentation tests may consume these milestones, while the existing
ownership corpus deliberately ignores the optional field.

## Extracting and auditing

Extract one saved bundle while developing:

```bash
node scripts/extract-rendering-fixtures.mjs \
  --bundle ~/.config/agent-code/debug-bundles/manual/<bundle-id> \
  --out /tmp/rendering-fixtures
```

The legacy bundle extractor reconstructs real transcript text and does not
redact it. **Its direct output must never be committed.** It remains local
evidence until a human hand-reduces it to the smallest useful shape and
replaces every identifying or sensitive value. Only that separately authored,
redacted derivative can become a check-in candidate, and the audit is the
final gate rather than a redaction tool. Require `LIKELY_SAFE` before adding the
derivative:

```bash
npm run fixture:audit -- --markdown testing/fixtures/feed-presentation/operation-families.json
```

The audit reports Claude, Codex, and OpenCode operations using the same
user-facing families expected by the feed presentation layer: file changes,
commands, terminal continuations, reads, searches, web work, collaboration, plans/tasks, questions, MCP,
images, notebooks, code intelligence, skills/workflows, workspace operations,
and a visible generic fallback. For Codex unified exec, a declared patch
literal is classified as a file change before `tools.apply_patch` appears; a
command that merely searches for the patch marker remains a command.
