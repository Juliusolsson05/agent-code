# Codex: hide the global AGENTS.md preamble

Fixes #1537. Refs #1419.

## Problem
Codex writes `# AGENTS.md instructions for <dir>` for a project AGENTS.md and a
bare `# AGENTS.md instructions` header for a global `~/.codex/AGENTS.md`. Our
feed filter and conversation catalog only knew the `for` form, so the global
preamble renders as a user prompt (26 of 36 local-corpus preambles).

## Change
- Feed (`rollout.ts`): match the way Codex does: trimmed start marker with
  optional ` for <dir>`, ending in `</INSTRUCTIONS>`, case-insensitive. The
  end marker keeps real prompts that only open with the heading.
- Catalog (`unwrap.ts`): widen the not-a-prompt prefix to the bare header.
- Corpus policy: keep the bare header verbatim after the `for` entry (first
  match wins, so existing redactions stay byte-identical).

## Verification
- Fail-first regression tests in `rollout.test.ts` and `unwrap.test.ts`,
  red with each fix reverted.
- Replay of all local Codex rollouts through the mapper: only the 26 bare
  preambles disappear (1826 → 1800 user rows).
- `npm run typecheck`, conversations and Codex transcript suites.

## Out of scope
Other injected user rows seen in the replay (`<hook_prompt>`,
`<codex_internal_context>`, `<external_codex_apps_open…>`,
`<goal-loop-continuation>`, `<local-command-*>`) are not investigated here.
