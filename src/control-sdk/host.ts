// Only composition roots construct registries. Features register capabilities
// through an injected host; the MCP adapter receives an invocation client.
export { createControlRegistry } from './core/registry'
export type ControlRegistry = ReturnType<typeof import('./core/registry').createControlRegistry>
