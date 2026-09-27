# Codex code-mode calls in the agent transcript reader (#1362)

Short plan: bug with a known root cause.

## Outcome
`read_agent_transcript` shows what a modern Codex agent actually did. Today `extractCodexResponseItem` reads only `function_call` / `function_call_output`. Every `custom_tool_call` and `custom_tool_call_output` is skipped. That form is how Codex 0.144 and later run shell commands and patches, so a Codex child's `timeline`, `shell_commands` and `file_changes` are mostly empty.

## Evidence (verified 2026-09-27 on the owner's `~/.codex/sessions`, 2,457 rollouts; do not re-derive)
- **`custom_tool_call` names:** `exec` 98,327 and `apply_patch` 7,538 (the older top-level form); nothing else.
- **`exec` input is a JavaScript program** (Codex code mode), not a command.
  - `tools.*` calls per script: 0 in 1,386; 1 in 82,604; 2 in 7,189; 3 in 4,074; 4 in 2,159; 5+ in 940.
  - Most-called tools: `exec_command` 87,300, `apply_patch` 10,784, `write_stdin` 9,625, `web__run` 5,029, then MCP tools.
- **`exec_command` arguments are JS object literals,** mostly with unquoted keys: 73,789 of 87,184 are not JSON.
  - The renderer's existing lexical grammar (`src/providers/codex/renderer/adapters/command.ts`) decodes 80,313 of 87,379 (92%).
  - 5,339 are computed: `{cmd, workdir}` shorthand, or string concatenation.
  - 1,727 have no provable boundary (backtick templates).
- **`tools.apply_patch` arguments:** 2,022 of 10,786 are double-quoted strings. The rest are variables or templates, but the patch headers (`*** Update File: …`) are literal text in the script in every form.
- **`custom_tool_call_output.output`** in the September rollouts is an array of `input_text` blocks (13,085), rarely also an `input_image` (15), or a plain string (54).

## Design (contract)
- **Shared grammar.** `src/shared/codex/execScript.ts` holds the pure grammar moved from the renderer adapter: `matchingCallEnd`, `splitSimpleTopLevel`, `parseExecCommandArgument`, `decodeDoubleQuotedLiteral`. It adds `codexExecScriptCalls(script) → {tool, argument | null}[]`, in source order. The renderer adapter imports the moved helpers, and its presentation rules stay put.
- **Reader, `custom_tool_call` named `exec`,** mapped in source order:
  - Every `exec_command` call decodes: one `shell_command` per call (`command`, `cwd` from `workdir`).
  - Any `exec_command` call does not decode: **one** `shell_command` whose `command` is the whole script. **Ruling:** never a guessed command, and never a partial list that silently drops the computed one; the script's bytes are the evidence. Cost if wrong: a few long JS "commands" in `shell_commands`, still bounded by per-item truncation.
  - `apply_patch` calls: one `patch` item whose files come from the script's `*** Add/Update/Delete File:` / `*** Move to:` headers, via the same header parser OpenCode's patch text uses.
  - No `exec_command` or `apply_patch` call: one `tool_read` (`tool: 'exec'`, `target` = the called tool names, `excerpt` = the script), so the timeline still records that a script ran.
- **Reader, `custom_tool_call` named `apply_patch`:** a `patch` item with files from the input's headers.
- **Reader, any other `custom_tool_call` name:** the shared `classifyToolCall(name, JSON input or null)`.
- **Reader, `custom_tool_call_output`:** the raw-output item (`RAW_TOOL_OUTPUT`, hidden unless `include.rawToolOutputs`). The text is the string, or the joined text blocks.

## Tests
- **Fixture:** `testing/fixtures/agent-transcripts/codex-0.157-custom-calls.jsonl`, a slice of a real 0.157.1 rollout. Records are kept verbatim except for same-length redaction of paths and names, and no `session_meta` (it carries provider instructions). It holds:
  - a single decoded `exec_command`;
  - a multi-call script;
  - a computed-argument script;
  - an `apply_patch` script;
  - a non-command script;
  - their outputs, the user prompt, and the final answer.
- **Reader test** (`AgentTranscriptReader.system.test.ts`) on the fixture: the timeline, the `shell_commands` and `file_changes` projections, the raw outputs under `rawToolOutputs`, and `inspect` stats. Red on main: the timeline has only the messages.
- **Grammar unit tests:** `codexExecScriptCalls` over the fixture's scripts. The existing renderer adapter tests must stay green unchanged, which proves the move preserved behaviour.

## Verification boundary
The reader runs in main over files, so the tests exercise the real entry point. Nothing needs the app. Rollouts before code mode keep their `function_call` path, which is unchanged and still pinned by the existing test.

## Out of scope
- Pairing outputs to calls by `call_id`: the reader never paired `function_call_output` either.
- `write_stdin` and MCP calls inside scripts, beyond naming them in the `tool_read` target.

## Execution notes
- **Second fixture:** `codex-custom-call-patch-forms.jsonl` holds the two patch forms the 0.157 slice lacks, both recorded: a template-literal `tools.apply_patch` script (0.157, 2026-09-26) and a top-level `apply_patch` custom call (2026-05-19).
- **Fixture outputs:** the computed and non-command scripts' outputs are left out whole. One echoes MCP tool descriptions (provider text), and both run to 33–41 KB. Their calls are kept verbatim.
- **Ruling: no separate grammar unit tests.** `codexExecScriptCalls` is exercised through the reader's real entry point by both fixtures. The moved helpers are pinned by the renderer suites, which pass unchanged. A unit test over the same scripts would only repeat those assertions. Cost if wrong: a grammar edge that neither fixture holds.
- **Ruling: the recorded variable-argument patch** (`const patch = "…"; tools.apply_patch(patch)`) is not in a fixture, because its file name looks like a private project. It takes the same script-text path as the template form, which is covered.
