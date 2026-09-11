# Application architecture reference

Status: In progress.

## Outcome

Write a root `SPEC.md` describing the implemented application architecture at
`6a19e4ee`, including the pinned package submodules. This is an engineering
reference requested explicitly by the user, not a proposal to redesign the app.

## Work

1. Read entry points, contracts, service implementations, package APIs, storage,
   renderer state, remote/control surfaces, and build/test configuration.
2. Trace important end-to-end flows and identify ownership, authority, failure
   handling, and security boundaries. Check older design documents against code.
3. Write one substantial, navigable Markdown document with Mermaid UML class,
   sequence, and state diagrams plus component/deployment views. Link every
   subsystem to its implementation; distinguish implemented behavior from plans.
4. Validate Markdown links and diagram syntax, review diagrams visually, and
   cross-check architectural claims against source. Documentation-only changes
   do not require running unrelated runtime suites.
5. Review the final diff, record validation here, and commit the documentation.

## Constraints

- Keep the user's checkout and unrelated work intact; use the dedicated
  `docs/application-architecture` worktree.
- Do not edit runtime behavior, package pointers, or existing subsystem designs.
- Describe meaningful responsibilities and constraints, not a generated symbol
  dump. Name conceptual diagram elements when they are not literal classes.
- Treat source as authoritative when dated plans or comments disagree with it.
