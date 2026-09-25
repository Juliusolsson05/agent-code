import type { FeatureReference } from '@control-sdk'

// The goal loop control reference (#1001). Kept as its own feature because
// the loop is a capability the user steers, not one the user drives start to
// finish: the model writes the continuation prompt, and this surface exists
// to watch and interrupt it.
export const controlReference = [{
  id: 'goal-loop',
  title: 'Harness-owned goal loops',
  purpose: 'Keep an agent working toward a goal across turn boundaries until it reports the goal complete, without the user re-prompting.',
  ui: 'An always-on per-pane status strip while a loop exists, a latched Goal Loop overlay with pause, resume, raise-cap and stop controls (Close leaves it), Dismiss on an ended loop to clear its strip, and a Stop Goal Loop session command.',
  prerequisites: 'Turn Goal Loop on for the agent that should run loops (off by default; per agent in the Agent MCP Servers picker, or per provider in Settings → MCP). The agent starts the loop itself with goal_loop_start when asked; users never write the continuation prompt.',
  workflow: [
    'Turn Goal Loop on for the agent in Agent MCP Servers; it reloads with the loop tools.',
    'Ask the agent to run a loop on an outcome; it calls goal_loop_start with the goal and its own continuation prompt.',
    'Whenever the agent stops before completion, Agent Code re-prompts it with the next continuation, up to the budget (default 25).',
    'The strip above the pane shows state and budget; open the Goal Loop overlay for controls.',
    'The loop ends when the agent calls goal_loop_complete (done or blocked), the budget pauses it, or you stop it.',
  ],
  outcome: 'The pane strip reads e.g. “Goal loop · active · iteration 3/25 · <goal>” with Pause and Stop, and the latched overlay centers the full state with all controls.',
  cautions: 'Loops consume model calls on every continuation; the budget pauses rather than kills, and Raise cap re-arms it knowingly. A paused(loop) after a restart or provider switch stays paused until resumed. complete(done) is the agent\'s own claim of completion, not a verified fact; the summary states what it believes finished.',
  commandIds: ['goal-loop-preview', 'goal-loop-stop', 'agent-mcp-servers'],
}] satisfies FeatureReference[]
