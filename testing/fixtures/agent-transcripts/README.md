# Agent transcript fixtures

Recorded provider transcripts for `src/main/agentTranscripts/AgentTranscriptReader.system.test.ts`.

Rules for every file here:
- Records are copied verbatim from real transcripts.
- Only the account name in home-directory paths is redacted, at the same length (`juliusolsson` → `xxxxxxxxxxxx`).
- `session_meta` is never copied, because it carries provider instructions.
- An output record is left out whole, never trimmed, when it is large or quotes provider text (for example MCP tool descriptions).

## `codex-0.157-custom-calls.jsonl` (#1362)
A slice of one Codex 0.157.1 rollout from `~/.codex/sessions/2026/09/26/`, rollout `01a0e041-775b-7833-8b99-e8bd26694569`.
- **Records:** the user prompt, one commentary message, five `exec` scripts, three outputs, and the final answer.
- **Scripts, one per census shape:** a single decoded command, two commands, a computed argument, a patch, and a non-command script.
- **Left out:** the outputs of the computed and non-command scripts, at 32 KB and 40 KB. The second echoes MCP tool descriptions.

## `codex-custom-call-forms.jsonl` (#1362, #1368 review)
Six single records from five rollouts, each a form the 0.157 slice lacks.

| Record | Form | Rollout |
|---|---|---|
| 1 | a template-literal `tools.apply_patch` script | 2026-09-26, `01a0e076-e0f5-…` |
| 2 | a top-level `apply_patch` custom call | 2026-05-19, `019e3f13-e24e-…` |
| 3 | a patch whose text quotes `tools.exec_command(...)`, which must not become a command | 2026-07-12, `019f57c0-3568-…` |
| 4 | a script calling only an MCP tool | 2026-09-07, `8b16cfb8-2cc9-…` |
| 5 | two `apply_patch` calls with `${path}` headers around a command | 2026-09-24, `01a0d6a2-8f1f-…`, line 2453 |
| 6 | four `exec_command` calls, two with template commands | 2026-09-24, `01a0d714-17ae-…`, line 21738 |
