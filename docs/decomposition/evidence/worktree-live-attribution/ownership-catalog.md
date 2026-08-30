# Live attribution ownership catalog

This catalog freezes the semantic judgment applied to the fixed-cutoff corpus.
It is deliberately separate from production code: a parser may discover these
carriers, but it may not redefine what authority each carrier has merely to
make its implementation convenient.

| Recorded source | Class | May set active? | May name matched branch? | Ownership rule |
|---|---|---:|---:|---|
| Claude `worktree-state` enter/exit | Exact direct activity | Yes | No | Explicit provider lifecycle selects a checkout; current Git identity names a matched checkout. |
| Claude tool `file_path` / `path` / `cwd` / `workdir` | Direct activity | Yes | No | The tool target describes where the recorded operation happened and outranks generic envelope metadata. |
| Claude conversation-envelope `cwd` | Bootstrap/affinity | Only when no direct active evidence exists | No | Useful for launch/current-conversation fallback, but repetition or later array order cannot repossess active. |
| Claude conversation-envelope `gitBranch` | Diagnostic-only when path matches Git; fallback when unmatched | No | No when matched | Git is the current source of truth for a matched worktree's branch. |
| Codex `CommandExecution.cwd` and `FileChange` paths | Direct activity | Yes | No | Recorded operations move active state; current Git identity names the checkout. |
| Codex `session_meta.cwd` / `turn_context.cwd` | Bootstrap/affinity | Only when no direct active evidence exists | No | Launch and turn affinity may remain main while commands execute in a linked worktree. |
| Equal proxy `client_metadata.thread_id` and `session_id` on that pane's private Responses proxy | Exact identity candidate | No | No | It may request an exact rollout only after locator proof that request id = filename UUID = `session_meta.id`; the process-wide lease remains authoritative. |
| Proxy identity with unequal/malformed ids | Explicit non-evidence | No | No | Fail closed; do not select by cwd, recency, or partial equality. |
| Proxy identity that resolves to an already leased sibling path | Explicit non-evidence for this pane | No | No | At-most-one active tail wins; no stealing or fallback guessing. |
| Session launch cwd with no provider records | UI fallback | Only as clearly fallback state | Only through Git match | It explains the current `main` chip during an evidence gap but cannot manufacture worktree activity. |
| Weighted historical primary context | Historical affinity | No | No | It supports long-lived context/history views but never overrides the most recent direct `active` location in the badge. |

## Recorded fixture routing

- `claude-cwd-tool-branch-conflict.json` exercises direct activity versus
  bootstrap/affinity and Git branch authority versus stale provider metadata.
- `codex-proxy-exact-identity-zstd.json` exercises the real compressed transport
  carrier and equality projection.
- `codex-0151-worktree-window.json` exercises exact rollout tailing without the
  0.149.1-only prompt profile and the later direct command transition.
- `codex-live-channel-gap.json` is negative evidence: the app had abundant
  semantic/screen traffic but no JSONL carrier, so renderer parsing alone could
  never repair the indicator.
- `git-worktree-identities.json` is the canonical path/branch catalog shared by
  provider and renderer contracts.
