# Application architecture reference

Status: Documentation complete; draft PR #897 remains open for review.

Progress: source investigation and the full application reference are complete. The user requested a draft PR during writing (#897), a large opening overview, and an established architecture-documentation structure. The document is now `ARCHITECTURE.md`, organized around arc42 with C4 structure views and UML class/state/sequence views. Early PR opening explicitly supersedes the normal fully-built-before-opening convention for this task.

Rendering adjustment: Mermaid sequence-label semicolons caused syntax errors and were repaired. Local parsing/rendering then passed, but GitHub still displayed `svg element not in render tree` and layout failures for valid diagrams. Keep the Mermaid source in the document as plain-text disclosures and commit generated SVG previews, with a pinned reproducible render/check script. This adds documentation assets/tooling without changing application behavior.

Opening-copy review: the user narrowed their feedback to the passage below the
opening diagram. Explain that map through a familiar action (sending a prompt),
define main/preload when introduced, and explain the separate storage areas.
Move documentation-format and notation details to Appendix B. Keep the existing
architecture sections and diagrams; this is a focused editorial revision.

## Outcome

Write a root `ARCHITECTURE.md` describing the implemented application architecture at
`6a19e4ee`, including the pinned package submodules. This is an engineering
reference requested explicitly by the user, not a proposal to redesign the app.

## Work

1. Read entry points, contracts, service implementations, package APIs, storage,
   renderer state, remote/control surfaces, and build/test configuration.
2. Trace important end-to-end flows and identify ownership, authority, failure
   handling, and security boundaries. Check older design documents against code.
3. Write one substantial, navigable arc42 Markdown document with C4 structure views and Mermaid UML class,
   sequence, and state diagrams plus component/deployment views. Link every
   subsystem to its implementation; distinguish implemented behavior from plans.
4. Validate Markdown links and diagram syntax, review diagrams visually, and
   cross-check architectural claims against source. Documentation-only changes
   do not require running unrelated runtime suites.
5. Review the final diff, record validation here, and push the completed documentation to the draft PR without merging.

## Constraints

- Keep the user's checkout and unrelated work intact; use the dedicated
  `docs/application-architecture` worktree.
- Do not edit runtime behavior, package pointers, or existing subsystem designs.
- Describe meaningful responsibilities and constraints, not a generated symbol
  dump. Name conceptual diagram elements when they are not literal classes.
- Treat source as authoritative when dated plans or comments disagree with it.

## Verification and review evidence

- Read implementation owners across main, preload, renderer, providers, MCP,
  Control SDK, workflows, remote clients, filesystem/editor services, storage,
  diagnostics and release tooling, including the six pinned package sources.
- All 42 diagram sources parse and render with Mermaid 11.4.1. Standalone SVG
  previews decode as browser images; reviewed the overview and all diagrams
  visually. Repeat rendering with `--check` verifies the committed bytes.
- Markdown validation covers 117 headings and 398 link/image references
  (272 unique targets), with no missing local files or section anchors.
  Twenty package source links match the inspected gitlink commits and paths.
- The render script passes `node --check`; `git diff --check` passes.
  Application runtime suites were not run locally for documentation changes.
- The previous draft revision passed both CI gates. The final documentation
  commit triggers a fresh run; its current result belongs in the PR checks.
- The source review found a separate tmux v2 workspace-reference mismatch.
  Issue #898 records the evidence and impact; this PR documents the limitation
  without changing runtime behavior. PR #897 also references documentation
  issue #100.
- Opening-copy revision: Markdown links/anchors and `git diff --check` pass.
  Compared all 42 diagram sources and Contents through Appendix A against the
  preceding commit; those portions are unchanged. No diagram regeneration or
  application runtime tests are needed for this prose-only revision.
