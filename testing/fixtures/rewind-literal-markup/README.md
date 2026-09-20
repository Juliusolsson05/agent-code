# Claude wrapper provenance (#930)

One Claude Code transcript in the real on-disk JSONL shape, holding both kinds
of message the Rewind draft has to tell apart:

- **Provider-authored wrappers** — a turn Claude Code itself wrapped, where the
  tag opens the message.
- **User-authored examples** — ordinary prose that merely *mentions* the same
  tags, which must survive untouched.

## Where each row comes from

| Row | Provenance |
|---|---|
| `<command-name>/model</command-name> … <command-args>claude-fable-5</command-args>` | **Recorded.** Copied verbatim from a real transcript in `~/.claude/projects` (`2026-08-29`, Claude Code 2.1.247), including its exact interior whitespace. Only `cwd`, `sessionId`, `uuid`/`parentUuid` and timestamps are sanitised. |
| `<bash-input>npm run build</bash-input>` | **Schema-derived, and labelled as such.** No `<bash-input>` user turn exists in the local corpus. The shape comes from the producer: `vendor/claude-code-src/full/utils/processUserInput/processBashCommand.tsx` builds the message as ``` `<bash-input>${inputString}</bash-input>` ```, i.e. the wrapper is the whole input string, and `prepareUserContent` places that string in the LAST content block. |
| the prose rows | Written for this fixture. They are the thing under test — what a user types when they are *asking about* the markup — so there is nothing to record. |
| `<system-reminder>` rows | One literal-only and one genuinely appended beside prose, which is how Claude Code really injects them. |

The envelope shape the row-level wrappers sit inside (`parentUuid`, `isSidechain`,
`userType`, `entrypoint`, `version`, `gitBranch`, …) is copied from real rows so
the parser's classifier sees what it sees in production.

## Re-capturing

Take a fresh `<command-name>` row from `~/.claude/projects/*/*.jsonl` and
sanitise `cwd`, `sessionId`, `uuid`, `parentUuid` and `timestamp` only — the
interior whitespace of the command block is load-bearing and must not be
reflowed. If a real `<bash-input>` user turn ever appears in a recording,
replace the schema-derived row with it and delete that caveat from this table.
