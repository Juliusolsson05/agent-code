import { describe, expect, it } from 'vitest'
import { buildGoalLoopContinuationPrompt } from './goalLoopPrompt.js'

describe('buildGoalLoopContinuationPrompt', () => {
  it('frames the agent-written instruction with the loop contract and budget', () => {
    const prompt = buildGoalLoopContinuationPrompt({
      goal: 'Migrate tests to Vitest.', loopPrompt: '  Keep migrating test files.  ', iteration: 3, maxContinuations: 25,
    })
    expect(prompt).toContain('<goal-loop-continuation>')
    expect(prompt).toContain('continuation 3 of 25')
    expect(prompt).toContain('Goal: Migrate tests to Vitest.')
    expect(prompt).toContain('goal_loop_complete')
    expect(prompt).toContain('<loop-instruction>\nKeep migrating test files.</loop-instruction>')
  })
})
