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

So a reader that only understands `tabs`/`root` finds **no projects and no
membership** in this file, while still seeing every session — which is the
failure this fixture exists to catch. `src/main/remote/workspaceProjection.ts`
reaches the phone through `agentActivity/workspaceProjection.ts`, and the phone
had no v3 test at all (#1031 item 4).

**Sanitization.** Structure and every value are unchanged, except three private
string fields. Each is replaced through a stable one-to-one placeholder map, so
equal values stay equal and distinct values stay distinct:

| Field | Replaced with |
|---|---|
| `cwd` | `/fixture/project-N` |
| `title` | `Title N` |
| `projectTabTitle` | `Project N` |

Verified afterwards to contain no absolute home path, username or real
directory name.
