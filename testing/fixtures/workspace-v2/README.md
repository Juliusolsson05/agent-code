# workspace-v2 fixtures

## `2026-09-19-live-workspace.sanitized.json`

This is a real `~/.config/agent-code/workspace.json`, persisted by the running
app on 2026-09-19. It holds one window and 27 sessions: 10 claude, 13 opencode,
2 codex, 1 grok and 1 terminal with a live `tmuxName`. It is the real v2
envelope (`{ version: 2, windows: [...] }`) that #898's startup reader
misread.

**Sanitization.** The structure and every value are unchanged, except for
three private string fields. Each is replaced through a stable one-to-one
placeholder map, so equal values stay equal and distinct values stay distinct:

| Field | Replaced with |
|---|---|
| `cwd` | `/fixture/project-N` |
| `title` | `Title N` |
| `projectTabTitle` | `Project N` |

IDs, `tmuxName`, kinds and layout are untouched: reconciliation matches on
exactly these. After sanitizing, a scan for `/Users/`, the account name,
`Desktop` and `Development` finds nothing.

To re-record, run the same walk over a live `workspace.json`: every
string-valued `cwd`, `title` or `projectTabTitle` key goes through a stable
placeholder map. Check the output the same way before committing it.

## `2026-09-23-agent-labels.sanitized.json`

The owner's live `workspace.json` a few minutes after the 2026-09-23 session
that filed #1145 (an agent could not act on "send a prompt to b33"). It has one
window and 34 sessions over three projects. Project B interleaves terminals and
an extension view with its agents, so the visible labels are not contiguous.
Nobody typed the label assertions in the tests: at the time,
`ac_agents_search {provider:"codex"}` returned B5, B16 and B28 for the three
Codex sessions.

It was sanitized the same way as the file above (`cwd`, `title`,
`projectTabTitle` placeholder maps). Two further changes: `drafts` is emptied
because it holds unsent prompt text, and the window `bounds` are normalized.
The scan for `/Users/`, the account name, `Desktop` and `Development` finds
nothing.
