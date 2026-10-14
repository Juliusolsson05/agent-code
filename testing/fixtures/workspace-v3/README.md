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

## `2026-10-14-live-workspace-with-hermes.sanitized.json`

A real `~/.config/agent-code/workspace.json`, captured from the running app on 2026-10-14, the day the Hermes pane (#1491) shipped. It holds one window, five projects and 15 sessions: 11 claude, 1 codex, 1 pi, 1 terminal and **1 hermes**. The Hermes row is the first real remote-kind row in the fixtures: it carries `remoteConnectionId` and a `provider-follow` `providerSessionId`.

It was sanitized exactly like the 2026-09-20 capture above:
- `cwd` was mapped to `/fixture/dir-N`;
- titles were mapped to `Title N`;
- `drafts` were dropped unconditionally;
- UUID-shaped ids were kept verbatim.

After sanitizing, the file was checked to contain no `/Users/` fragment and no account name.

## `2026-10-14-live-workspace-with-sidekicks.mutated.json`

A **mechanical mutation** of the capture above (#1493), not a recording. It is the on-disk shape the Sidekick feature writes, built from real rows rather than invented ones:

- **Two real rows became sidekick records.** One is a Claude row that no other row or lane refers to; the other is the Hermes row. Each row was moved out of the window slice into a top-level `sidekicks: {version: 1, records}` section, because a sidekick row never lives in a slice (plan invariant I1).
- **How each record's `meta` was built:** it is that row with `projectId` and `joinedAt` removed, `cwd` set to `/fixture/home`, and a `sidekickId` added.
- **Record ids** are fixed UUIDs (`00000000-0000-4000-8000-00000000000N`), so tests can name them.
- **The lane** that showed the Hermes row was emptied (the lane's `selectedSessionId` was removed), because a lane never points at a sidekick (plan invariant I5). After the mutation, neither moved session id appears anywhere in the window slice.

Used by `src/main/storage/workspaceFile.sidekicks.test.ts` and the Sidekick service and projection tests.
