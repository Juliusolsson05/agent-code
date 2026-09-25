# workspace-v3 fixtures

## `2026-09-20-live-workspace.sanitized.json`

A real `~/.config/agent-code/workspace.json`, persisted by the running app on
2026-09-20 — the **v3 unified-stage** envelope that #1013 migrated to. It holds
one window, three projects and 13 sessions: 5 claude, 3 opencode, 2 codex,
2 terminal and 1 extension-view.

The v3 shape differs from v2 in exactly the way the projections care about:

| | v2 | v3 |
|---|---|---|
| Projects listed under | `tabs` | `projects` |
| Membership | a leaf inside `tab.root`'s tile tree | the session's own `projectId` |
| Layout | `tabs[].root` split tree | `stage` (lanes + pool) |

### What this fixture is for

`agentActivity/workspaceProjection.test.ts` already covers the shared decoder
on v3 documents it builds by hand. What had **no** coverage was
`RemoteWorkspaceProjection` — the phone's own read model — on a v3 document at
all, and it is the class the phone's entire session list depends on. That is
the narrow gap this closes; see `src/main/remote/workspaceProjectionV3.test.ts`.

## Sanitization

Structure and every value are unchanged, except the private string fields
below. Each is replaced through a **stable one-to-one** map, so equal values
stay equal and distinct values stay distinct.

| Field | Replaced with | Note |
|---|---|---|
| `sessions[].cwd` | `/fixture/dir-N` | **Directories, not projects.** Several directories can belong to one project, so the numbering deliberately does not track `Title N`. |
| `sessions[].title` | `Title N` | shares the counter with the project titles below |
| `projects[].title` | `Title N` | |

### `drafts` — redact it, unconditionally

`workspace.drafts` persists **raw composer text** (`workspaceShape.ts`,
written by `useAutoSave.ts`), i.e. whatever the user had typed and not sent.

This capture happened to contain no drafts, so the committed file is clean —
but it is clean **by timing, not by process**. Anyone re-capturing this fixture
must drop `drafts` explicitly rather than trusting it to be empty. The v2
fixture redacted it deliberately for the same reason.

### What is deliberately left verbatim

UUID-shaped identifiers — `tldrIdentity`, `agentNameId`, `windowId`,
`providerSessionId`, tmux session names — are kept, because the tests join on
them and they are inert without the transcript files they key into. They are
not credentials. If a debug bundle or proxy dump is ever published from the
same machine, they would become a correlation key across those artifacts;
that is the known trade, and the same one the existing v2 owner fixture makes.

`extensionViewId` names a public repository on the same account that hosts this
one, so it discloses nothing the repository itself does not.

### Verified after sanitizing

No absolute path, no `/Users/` fragment, no home directory, no worktree path,
no branch name, no repository or client name, no prompt or goal text.
