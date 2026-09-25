# Claude wrapper provenance (#930)

One Claude Code transcript in the real on-disk JSONL shape, holding the three
kinds of message the Rewind draft has to tell apart:

- **Provider-authored wrappers** — a turn Claude Code wrapped around what the
  user entered, where the tag opens the message. The draft must read it.
- **Provider-authored output** — a turn Claude Code composed entirely itself
  (`<local-command-stdout>`). Not a prompt; it must not reach the picker.
- **User-authored examples** — ordinary prose that merely *mentions* the same
  tags, which must survive untouched.

## Where each row comes from

| Row | Provenance |
|---|---|
| `<command-name>/model</command-name> … <command-args>claude-fable-5</command-args>` | **Recorded.** Byte-identical to a real transcript in `~/.claude/projects` (`2026-08-29`, Claude Code 2.1.247), interior whitespace included. |
| `<command-name>/compact</command-name> … <command-args></command-args>` | **Recorded shape.** The EMPTY-args case, which is 7 of the 8 distinct `<command-name>`-first shapes in the corpus — the `/model` row above is the exception. |
| `<command-message>llm-prep</command-message>` … with args | **Recorded**, Claude Code 2.1.104. Prompt-type slash commands use a *different* formatter (`formatSlashCommandLoadingMetadata`) that opens with `<command-message>`, and in the local corpus this shape is the MAJORITY: 136 turns against 105 opening with `<command-name>`. |
| `<command-message>simplify</command-message>` … no args | **Recorded**, 2.1.104. Same formatter, args omitted entirely rather than left empty. |
| `<local-command-stdout>Set model to …</local-command-stdout>` | **Recorded shape.** 87 visible (non-meta) turns of this form exist locally, several carrying raw ANSI escapes. Claude Code writes the whole message; no user types one. |
| `<bash-input>npm run build</bash-input>` | **Schema-derived, and labelled as such.** No `<bash-input>` user turn exists in the local corpus (0 across 1941 files). The shape comes from the producer: `vendor/claude-code-src/full/utils/processUserInput/processBashCommand.tsx` builds the message as ``` `<bash-input>${inputString}</bash-input>` ```, and `prepareUserContent` places that string in the LAST content block. |
| the prose rows | Written for this fixture. They are the thing under test — what a user types when *asking about* the markup — so there is nothing to record. |
| `<system-reminder>` rows | One literal-only and one genuinely appended beside prose, which is how Claude Code really injects them. |

The envelope around every row (`parentUuid`, `isSidechain`, `userType`,
`entrypoint`, `version`, `gitBranch`, …) is copied from real rows so the
parser's classifier sees what it sees in production. Sanitised: `cwd`,
`sessionId`, `uuid`, `parentUuid` and `timestamp`. Dropped entirely:
`promptId`, which carries no meaning here.

## Re-capturing

Take fresh rows from `~/.claude/projects/*/*.jsonl` and sanitise only the
fields listed above — the interior whitespace of a command block is
load-bearing and must not be reflowed. Keep BOTH command shapes: a fixture
that records only one is how the `<command-message>` regression got through
review once already. If a real `<bash-input>` user turn ever appears, replace
the schema-derived row with it and delete that caveat from this table.
