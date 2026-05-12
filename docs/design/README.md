# `docs/design/` — sources of truth for non-obvious system designs

Files in this directory describe **what Agent Code's most complicated subsystems are and why they are shaped the way they are.** They are referenced by inline code comments and treated as authoritative. They are *not* changelogs, *not* running notes, *not* blow-by-blow histories of how a fix was derived.

## DO NOT change these files lightly

A design doc here gets touched **only when the actual system changes shape.** Renaming a constant, fixing a bug, or shipping a comment cleanup does not change the design — those land as code commits without a doc edit.

You should change a file in `docs/design/` when:

- A subsystem's responsibilities or invariants change.
- A new component enters or leaves the picture.
- A previously-load-bearing rule is replaced by a different one.
- A "deliberately out of scope" item is brought into scope.

You should NOT change a file in `docs/design/` when:

- Fixing a bug whose root cause is consistent with the documented design.
- Refactoring within the existing rules.
- Adjusting a tunable (a TTL, a threshold, a cap) that the doc already describes by purpose rather than by value.
- Rewording a comment for clarity.

When in doubt: the doc is wrong if and only if its description no longer matches reality. If reality matches and the wording is just unclear, that's a code-comment problem, not a design-doc problem.

## What goes here vs. elsewhere

| Kind of doc | Lives in |
|---|---|
| Source-of-truth design explanation, evergreen | `docs/design/<topic>.md` (this directory) |
| Date-stamped plan, executed once | `docs/superpowers/plans/YYYY-MM-DD-<slug>.md` |
| Long-form diagnostic / forensic write-up of a specific incident | `docs/superpowers/plans/YYYY-MM-DD-<slug>-findings.md` |
| Style or convention reference | `docs/<topic>-style.md` (root of `docs/`) |
| README for the repo / a package | `README.md` next to the code |

If you are documenting *what is true today and is expected to stay true*, it belongs here. If you are documenting *what we did in a particular moment*, it belongs in `plans/`.

## How to add a new file

1. Pick a short, durable filename: one subsystem, one file. `ghost-system.md`, not `2026-05-07-ghost-fix.md`.
2. Write it in plain English first, then the technical rules. Aim for the level a senior engineer joining the team next month needs — not a domain expert, not a beginner.
3. End with a `## Warning` section explaining what care must be taken when modifying the subsystem, and what the load-bearing invariants are. The whole point of these docs is to make future-you stop and read before pulling a thread.
4. Reference the doc from inline comments at the top of every file involved in the subsystem. One line per file is enough: `// See docs/design/<topic>.md for the canonical explanation.` Don't repeat the doc's contents in code comments — code comments explain *this file's role* in the design, the doc explains *the design.*

## Current files

- [ghost-system.md](ghost-system.md) — The provisional-record bridge between the proxy semantic stream and the durable JSONL transcript. Covers the five-rule render predicate, reconciliation, the orphan TTL, the sidecar shape filter, and the dual-owner relationship with `SemanticStreamingTurn`.
