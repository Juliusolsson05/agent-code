# Command Palette Prompt Template Search Plan

## Goal

Add an app setting, disabled by default, that lets the top-level command palette include matching prompt templates after the user starts typing. The empty command menu must remain command-only, and the existing dedicated prompt-template picker must keep its current behavior.

## User-visible contract

- Add a Commands setting that clearly describes this as an opt-in expansion of typed command-palette search.
- With the setting off, command-palette browsing and search remain unchanged.
- With the setting on, an empty command query still shows only commands.
- With the setting on and a non-empty command query, prompt templates may match by title or description. Template body text is deliberately excluded because hidden prose should not produce surprising search results.
- Commands and templates share one relevance ordering instead of placing every template after every command.
- Selecting a template from command search reuses the existing prompt-template insertion flow, including variable filling and live `buildBody` resolution.
- Exact agent-coordinate navigation such as `A2` and `A2!` remains the first row and keeps its existing semantics.

## Implementation

1. Extend persisted renderer settings with an opt-in boolean, a strict off-by-default coercion rule, and a Commands-category toggle.
2. Introduce a typed command-palette row ranker that combines commands and prompt templates only for an enabled, non-empty search. Keep ordinary command browse sorting and headers delegated to the existing command ranker.
3. Change the top-level command palette to navigate, render, preview, and execute the heterogeneous result rows while preserving the synthetic agent-coordinate row at index zero.
4. Reuse the existing template execution callback rather than creating a parallel insertion path.

## Verification

- Unit-test the persisted default/coercion behavior.
- Unit-test the setting registry toggle contract.
- Unit-test the combined row ranker for the disabled state, empty-query boundary, title/description matching, body exclusion, cross-type relevance, and command-only compatibility.
- Run the focused unit tests, TypeScript validation, linting, and the repository's relevant broader test contract before opening the PR.

## Non-goals

- Do not add templates to the empty/default command menu.
- Do not replace or remove the dedicated prompt-template picker or manager.
- Do not make template bodies searchable from the top-level command palette.
- Do not change prompt-template storage, insertion modes, or submission behavior.
