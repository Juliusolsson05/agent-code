# Tests whose outcome depends on load or build state (#1107, remaining sites)

## Remaining sites (from the issue and its correction comment)
| Site | Cause | Decision |
|---|---|---|
| `lspServerCreation.system.test.ts` | fixed `setTimeout(20)` | already fixed in #1108 |
| `lazy-prose/index.renderer.test.tsx` (#700) | The first compile of the lazily imported Markdown chunk is measured by a 5 s `findByText`, which equals Vitest's 5 s test default, so its useful message ("never appeared") can never fire | **Load the chunk in `beforeAll`**, awaiting the import itself. `findByText` then measures only the render, with its own default and a real message. |
| `sessionManager.terminalReplay.test.ts` | Dynamic `import()`s of `@xterm/headless` and `sessionManager`'s whole module graph run inside the test body, against the 5 s test budget | **Static imports.** `vi.mock` is hoisted, so the mocks still apply. Module loading moves to collection, outside the test's budget. |
| `workflows/control.system.test.ts` | Forks the BUILT workflow worker (`packages/workflow-mcp/dist/workflowWorker.js`). In a fresh worktree `dist` doesn't exist; the package throws `worker-missing`, the test only sees the operation never completing, and it times out after 5 s with no reason. | **A precondition** that fails at once, saying the worker must be built (`npm run build` in `packages/workflow-mcp`). CI builds it, so CI is unaffected. The test does not build it itself: a build inside a unit of the suite would be slow, and racy across parallel workers. |

Rules held:
- No budget is widened.
- Each wait is either on its condition or on the real module load.

## Evidence
- The fresh worktree has no `packages/workflow-mcp/dist`. On `origin/main` the control test fails after 5 s with a `waitFor` timeout; after the fix, it fails immediately with the precondition message.
- For the other two, the load moves out of the test body. The PR records the measured load time that used to count against the budget.
