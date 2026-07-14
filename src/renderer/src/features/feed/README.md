# Feed presentation architecture

This directory owns the React presentation of an already-clean feed. Its job is to show what the agent is doing—editing a file, running a command, searching, delegating—not the provider protocol that described the work.

The detailed evidence and migration plan live in [Feed Presentation Rewrite — Ground-Up Plan](../../../../../docs/superpowers/plans/2026-07-12-feed-presentation-ground-up-rewrite.md). This README is the durable architecture contract for code in this directory.

## The deliberate shadcn-style choice

We follow the useful part of shadcn's model: small components are copied into the product, readable in place, composed directly, and owned by this repository. This is a source-ownership convention, not a runtime shadcn dependency and not an attempt to imitate its visual design.

Why this model fits the feed:

- Future agents can read and change the exact primitive that ships. There is no opaque component package or theme adapter hiding behavior.
- Shared pieces stay small and composable. A diff line, status badge, output well, or disclosure can be reused without inventing a universal card API.
- Product-specific accessibility, streaming, and performance decisions remain next to the code that depends on them.
- Naming and placement communicate scope. A primitive does not silently grow provider knowledge or session ownership rules.

The constraint matters as much as the inspiration: do not turn the local component collection into our own framework. There is no component generator, plugin API, detector DSL, provider-specific React registry, class hierarchy, or feed-level design-system store. Add ordinary source files and compose them.

## The frozen boundary

The presentation rewrite begins after `FeedRenderItem[]`:

```text
provider channels and committed transcripts
                  |
                  v
session-runtime + semantic folding + ownership ledger   FROZEN
                  |
                  v
FeedRenderItem[]                                         FROZEN CONTRACT
                  |
                  v
projectFeedPresentation(...)                            PURE ADAPTER
                  |
                  v
PresentationNode[] + ProjectionReceipt[]
                  |
                  v
PresentationRow -> OperationRow / message / system UI
```

The following are upstream truth and are not presentation concerns:

- `src/renderer/src/session-runtime/**`
- `src/renderer/src/rendering/**`
- provider headless channels and transcript mappers
- ghost creation and reconciliation
- ownership candidates and decisions
- feed ordering and stream-phase derivation
- the variants and semantics of `FeedRenderItem`

The projector may interpret data already handed across that boundary. It must not add another event stream, reducer, mutable store, visibility policy, or ownership decision. Pure provider extractors may decode provider-specific payloads, but they must not decide whether a row exists.

## Directory and naming contract

```text
features/feed/
  presentation/
    types.ts                 finite presentation union and operation families
    classifyOperation.ts     provider vocabulary -> user-intent family
    projectBlock.ts          live/committed block normalization
    projectFeed.ts           FeedRenderItem[] -> pure projection + receipts
  ui/
    operations/
      OperationRow.tsx       one stable shell for every operation lifecycle
      PresentationRow.tsx    exhaustive top-level PresentationNode painter
      StructuredOperationCard.tsx
    artifacts/               rich family bodies reused by OperationRow
    kit/                     copied-owned, provider-agnostic UI primitives
    rows/                    message, system, notification, and drill-in rows
    semantic/                low-level live activity/interaction UI only
    markdown/                feed prose components
  lib/                       feed-specific pure helpers
  model/                     frozen FeedRenderItem model
  ledger/                    frozen ownership-to-feed bridge
```

Naming rules for new work:

- React components use PascalCase and a matching filename: `OperationRow.tsx` exports `OperationRow`.
- Pure modules and functions use camelCase filenames and names: `projectFeed.ts` exports `projectFeedPresentation`.
- Presentation-family values use stable kebab-case user intent such as `file-change` or `task-plan`; never use a provider event name as a family.
- Pure tests use `*.test.ts`. DOM/React tests use `*.renderer.test.tsx`.
- Put a component in `ui/kit/` only when it is provider-agnostic and useful to more than one family. Kit components accept display data, not transcript blocks, stores, or provider types.
- Put lifecycle coordination in `ui/operations/`. Put a rich domain body in `ui/artifacts/` only when the family genuinely benefits from dedicated presentation. Do not make one artifact per provider tool name.
- Import owned components directly. A barrel or registry must not become a second dispatch system.

Some existing artifact filenames predate the PascalCase convention. Migrate them when the file is materially changed; filename churn alone is not worth obscuring the architectural rewrite.

## One pure projector

`projectFeedPresentation` is the only adapter between `FeedRenderItem[]` and feed React UI. It receives the clean ordered items plus read-only correlation indexes and returns:

- a small `PresentationNode[]` union;
- a `ProjectionReceipt[]` audit trail.

The function performs no IO, owns no mutable session state, and does not read from React. Local maps used during one call only correlate evidence for that returned projection.

The top-level union stays intentionally small: messages, thinking, images, operations, grouped activity, system rows, and an explicit fallback. Tool names do not add top-level node variants. They become one of the finite operation families.

### Receipts make omission explicit

Every source `FeedRenderItem` is accounted for as one of:

- `painted`: it produced one or more visible presentation nodes;
- `absorbed`: it enriched another node, with that target id recorded;
- `fallback`: its unknown shape produced an inspectable fallback row.

A paired tool result is normally absorbed into its operation. An empty, known protocol tick may also be absorbed. Unknown content is not allowed to disappear through `return null`. The receipt is why we can simplify the visible feed without making debugging or replay ambiguous.

## One operation, one row

`OperationRow` is the mounted outer component from the first recognizable input prefix through completion:

```text
preparing -> streaming -> running/waiting -> complete | error | denied | cancelled
```

Live semantic evidence and committed transcript evidence are two descriptions of the same operation, not two rendering planes. They converge into one `OperationVM`; later evidence enriches its props. The outer `data-operation-id` element and React key must remain stable when:

- partial input becomes parseable;
- input becomes a running tool call;
- a result arrives;
- committed ownership replaces live semantic ownership.

Stable ids prefer, in order, the provider call/tool-use id, an upstream item correlation id, a committed block id, and finally a source key plus block index. Never key an operation only by its visible array position.

Classification is monotonic. Once structural evidence proves `file-change`, for example, a later complete wrapper may add a path or result but must not turn it back into `generic`. Truly ambiguous partial input renders a compact Preparing state. Raw wrapper JavaScript or escaped JSON is never the normal fallback.

## Operation families

Families describe what the user needs to understand. Provider spellings are extraction details.

| Family | User-facing work | Representative inputs |
| --- | --- | --- |
| `preparing` | Intent is not structurally knowable yet | partial unified wrapper or partial JSON |
| `file-change` | Create, edit, move, or delete files | Claude Edit/Write, Codex apply_patch/unified patch, OpenCode edits |
| `command` | Start and follow a shell command | Bash, PowerShell, exec_command, local shell, OpenCode bash |
| `terminal-interaction` | Continue or wait for an existing terminal | write_stdin, wait/poll |
| `read` | Read a file or transcript | Read, FileRead, OpenCode read |
| `search` | Search text, paths, symbols, or tools | Grep, Glob, LS, ToolSearch |
| `web` | Search, open, find, or fetch web content | WebSearch/WebFetch, Codex web actions |
| `collaboration` | Spawn, message, wait for, inspect, or stop agents | Claude Agent/Task, Codex collaboration, orchestration MCP |
| `task-plan` | Manage plans, tasks, todos, and schedules | TodoWrite, update_plan, Task*, ScheduleWakeup |
| `question` | Request authoritative user input | AskUserQuestion, request_user_input |
| `mcp` | Call a general MCP tool and render typed output | non-specialized `mcp__*` calls |
| `image` | Generate or inspect images | image generation, view_image |
| `notebook` | Edit notebook cells | NotebookEdit |
| `code-intelligence` | Navigate symbols, references, and diagnostics | LSP tools |
| `skill-workflow` | Run a skill, workflow, monitor, or report | Skill, Workflow, Monitor |
| `workspace` | Change workspace, worktree, plan mode, or config state | EnterWorktree, ai_workspace*, Config |
| `generic` | Structured, visible long-tail operation | a tool with no proven specialized family |

Known Agent Code collaboration/workspace MCP calls are classified before generic MCP. `generic` is a total safety net, not permission to dump transport data.

## Claude, Codex, and OpenCode converge before React

React must not choose between provider-specific component trees. Providers decode their wire shapes, then the projector normalizes them to the same operation model:

| User intent | Claude examples | Codex examples | OpenCode examples | Shared presentation |
| --- | --- | --- | --- | --- |
| Edit a file | Edit, MultiEdit, Write | apply_patch, unified `exec` patch | edit/write/patch parts | `file-change` operation with streaming diff |
| Run a command | Bash, PowerShell | exec_command, local shell, unified `exec` command | bash | `command` operation with ANSI/status/output |
| Inspect code | Read, Grep, Glob, LS | read/search tools and proven command metadata | read, grep, glob | `read` or `search` operation |
| Delegate work | Agent, Task | spawn/send/follow-up/wait/list/close | task | `collaboration` operation |
| Track work | TodoWrite, Task*, schedules | update_plan and task tools | todo/task | `task-plan` operation |

Provider-specific code belongs in existing pure extractor modules when a real payload cannot be decoded generically. It returns data or evidence; it does not return JSX. OpenCode gets an extractor only when recorded OpenCode shapes require one—symmetry alone is not a reason to create a file.

The surviving `ui/resolve/fromLive.ts` and `fromCommitted.ts` modules are
deliberately narrow view-model adapters for existing artifact bodies. They do
not choose a family or component; the finite classifier and `OperationRow` do.
Do not add another registry beside them, and do not delete useful pure adapters
merely to make the directory diagram look more symmetrical.

## Progressive disclosure is the default UI policy

Every operation exposes three levels:

1. Always visible: verb, subject, lifecycle status, and the most important result or count.
2. Inline when useful: a bounded live preview such as diff lines, recent ANSI output, found paths, an active plan step, or a selected answer.
3. Expandable: complete output, verbose parameters, metadata, and source/debug protocol.

Enrichment may summarize but never erase source output. A JSON table, test summary, diagnostic list, or MCP typed view sits above an expandable original result. If the formatter is incomplete, the user can still inspect and copy what the tool produced.

Raw input is debug material. During partial parsing, show useful known fields or “Receiving parameters…”; do not paint an escaped JSON slab. The exact payload remains available only under an explicitly labeled source/debug disclosure and in debug bundles.

## How to extend the feed without growing a framework

When a new tool shape appears:

1. Add a redacted replay fixture or a focused unit fixture representing the real provider shape, including partial prefixes when it streams.
2. Decode only the needed provider quirk in a pure extractor. Reuse shared partial scanners rather than adding a parser in React.
3. Map the tool to an existing user-intent family in `classifyOperation.ts`. Add a family only when its lifecycle and useful presentation are genuinely different.
4. Normalize live and committed evidence in `projectBlock.ts`, then verify `projectFeed.ts` gives both forms the same operation id.
5. Reuse `ui/kit/` primitives and an existing family body. Add a dedicated artifact only when it provides repeated, fixture-backed user value beyond `StructuredOperationCard`.
6. Assert that every source has a painted, absorbed, or fallback receipt and that live-to-committed replacement preserves the mounted `OperationRow`.

Do not add a provider renderer registry, a dynamic card plugin, a second feed store, or a tool-name component tree. A finite classifier plus exhaustive union is intentionally boring: precedence is visible, unknowns are safe, and future agents can reason about the entire system without discovering nested extension machinery.

## Review invariants

Every change under this feature should preserve these checks:

- The same recorded inputs still produce the same ordered `FeedRenderItem[]` at the frozen boundary.
- Intent appears as soon as structurally proven; rendering does not wait for valid final JSON or a result.
- Wrapper JavaScript, provider XML, escaped JSON, and wire event names stay out of the normal feed.
- The stable operation id and mounted outer row survive streaming and ownership hand-off.
- File changes show honest red/green content immediately, with lexical/LSP enrichment allowed to upgrade spans without delaying text.
- Commands preserve live ANSI output and final status; structured summaries retain expandable raw output.
- Questions are interactive only while authoritative condition state owns that exact request.
- Unknowns become structured fallback rows, never blank space.
- Projection receipts account for every clean source item.
- Accessibility and modal/input ownership are not delegated to ad hoc cards.
- New non-obvious decisions include thick WHY comments so the next agent does not have to reverse-engineer the constraint.

The result should feel highly tailored to the user's work while remaining architecturally small: one clean boundary, one pure projection, one stable operation shell, a finite family map, and locally owned composable UI.
