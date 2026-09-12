// Only composition roots construct registries. Features register capabilities
// through an injected host; the MCP adapter receives an invocation client.
export { createControlRegistry } from './core/registry'
export { createControlExecutor } from './core/executor'
export type ControlRegistry = ReturnType<typeof import('./core/registry').createControlRegistry>
