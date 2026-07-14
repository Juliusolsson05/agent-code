import { startWorkflowWorker } from 'workflow-mcp/worker'

// WHY this exists instead of pointing utilityProcess at package source:
// electron-vite emits this named entry and its chunk graph into out/main, so
// development, app.asar, and an optional app.asar.unpacked fallback all launch
// the exact code that was built and signed with Agent Code. Importing a
// submodule source path at runtime would work in npm start and disappear in a
// packaged .app — the most dangerous possible split for workflow execution.
startWorkflowWorker()

