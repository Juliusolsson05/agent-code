import assert from 'node:assert/strict'

import { isCodexReadyForPromptScreen } from '../src/providers/codex/runtime/codexReadyForPrompt'

const readyScreen = [
  '╭──────────────────────────────────────────────────────────╮',
  '│ directory:   /tmp/project                                │',
  '│ permissions: YOLO mode                                   │',
  '╰──────────────────────────────────────────────────────────╯',
  '',
  '  Tip: Use /compact when the conversation gets long.',
  '',
  '',
  '› Improve documentation in @filename',
  '',
  '  gpt-5.5 medium fast · /tmp/project',
].join('\n')

const readyNonGptModelScreen = [
  '╭──────────────────────────────────────────────────────────╮',
  '│ directory:   /tmp/project                                │',
  '│ permissions: YOLO mode                                   │',
  '╰──────────────────────────────────────────────────────────╯',
  '',
  '  Tip: Use /compact when the conversation gets long.',
  '',
  '',
  '› Improve documentation in @filename',
  '',
  '  o3 medium · /tmp/project',
].join('\n')

const trustDialogScreen = [
  '> You are in /tmp/project',
  '',
  'Do you trust the contents of this directory?',
  '',
  '› 1. Yes, continue',
  '  2. No, quit',
].join('\n')

const startupScreen = [
  '╭──────────────────────────────────────────────────────────╮',
  '│ directory:   /tmp/project                                │',
  '╰──────────────────────────────────────────────────────────╯',
].join('\n')

const workingScreen = [
  '╭──────────────────────────────────────────────────────────╮',
  '│ directory:   /tmp/project                                │',
  '╰──────────────────────────────────────────────────────────╯',
  '',
  '› Reply with exactly ISSUE_211_OK.',
  '',
  '◦ Working (4s • esc to interrupt)',
  '',
  '  gpt-5.5 medium fast · /tmp/project',
].join('\n')

const approvalScreen = [
  '╭──────────────────────────────────────────────────────────╮',
  '│ directory:   /tmp/project                                │',
  '╰──────────────────────────────────────────────────────────╯',
  '',
  'Allow command?',
  '› Approve',
  '  Deny',
  "  Yes, and don't ask again for commands that start with `git status`",
  '',
  '  gpt-5.5 medium fast · /tmp/project',
].join('\n')

assert.equal(isCodexReadyForPromptScreen(readyScreen), true)
assert.equal(isCodexReadyForPromptScreen(readyNonGptModelScreen), true)
assert.equal(isCodexReadyForPromptScreen(trustDialogScreen), false)
assert.equal(isCodexReadyForPromptScreen(startupScreen), false)
assert.equal(isCodexReadyForPromptScreen(workingScreen), false)
assert.equal(isCodexReadyForPromptScreen(approvalScreen), false)
assert.equal(isCodexReadyForPromptScreen(''), false)

console.log('test-codex-ready-for-prompt passed')
