import { describe, expect, it } from 'vitest'
import { applyClaudeQueueDequeue } from '@renderer/workspace/claudeQueueReconstruction'
import type { QueuedMessage } from '@renderer/workspace/workspaceState'

// Regression coverage for the 2026-07-07 soak bundles
// debug-bundles/manual/2026-07-07T13-17-20-472-5b19529f ("completed agents
// renders as queued") and .../2026-07-07T13-17-48-452-5b19529f ("a queued
// prompt did not get shown in the feed"). Both fall out of reconstructing
// Claude's PRIORITY queue with FIFO drop-head semantics; see
// claudeQueueReconstruction.ts for the full write-up.

function q(content: string, timestamp = String(Math.random())): QueuedMessage {
  return { content, timestamp }
}

// Mirrors the shape Claude parks in queuedMessages for a completed subagent
// (priority 'later'). parseTaskNotification only requires the opening tag.
function taskNotification(summary: string): string {
  return [
    '<task-notification>',
    '<task-id>abc</task-id>',
    '<status>completed</status>',
    `<summary>${summary}</summary>`,
    '</task-notification>',
  ].join('\n')
}

describe('applyClaudeQueueDequeue', () => {
  it('returns the same array reference for an empty queue', () => {
    const queue: QueuedMessage[] = []
    expect(applyClaudeQueueDequeue(queue)).toBe(queue)
  })

  it('drops the head for a homogeneous plain-prompt queue (unchanged FIFO)', () => {
    const first = q('first prompt', '1')
    const second = q('second prompt', '2')
    const third = q('third prompt', '3')
    expect(applyClaudeQueueDequeue([first, second, third])).toEqual([second, third])
  })

  it('drops the head for a homogeneous task-notification queue', () => {
    const a = q(taskNotification('Agent A finished'))
    const b = q(taskNotification('Agent B finished'))
    expect(applyClaudeQueueDequeue([a, b])).toEqual([b])
  })

  it("removes the 'next' user prompt ahead of an earlier 'later' notification", () => {
    // This is the exact drift the bundles captured: a completed-agent
    // task-notification (priority 'later') is enqueued FIRST, then the user
    // types a prompt (priority 'next'). Claude delivers the prompt first, so
    // the notification must SURVIVE the dequeue — the old slice(1) wrongly
    // dropped the notification and left the already-delivered prompt behind.
    const notif = q(taskNotification('Agent finished'))
    const prompt = q('user typed this while busy')
    expect(applyClaudeQueueDequeue([notif, prompt])).toEqual([notif])
  })

  it("keeps completed notifications queued while draining a later user prompt", () => {
    // Bundle B2 shape: two completed task-notifications sit in the queue and
    // the user's prompt is delivered. The prompt leaves; both notifications
    // stay until Claude reaches a 'later' drain point.
    const tn1 = q(taskNotification('Audit structural conventions + isolation finished'))
    const tn2 = q(taskNotification('Audit test + fixture conventions finished'))
    const prompt = q('please also check the queue strip')
    expect(applyClaudeQueueDequeue([tn1, tn2, prompt])).toEqual([tn1, tn2])
  })

  it("drops the user prompt at the head when it precedes a notification", () => {
    const prompt = q('earliest prompt')
    const notif = q(taskNotification('Agent finished'))
    expect(applyClaudeQueueDequeue([prompt, notif])).toEqual([notif])
  })
})
