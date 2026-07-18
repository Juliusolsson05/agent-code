import { describe, expect, it } from 'vitest'

import { detectGitIntent } from './detect'
import {
  parseGitCommit,
  parseGitPush,
  parseGitStatus,
  stripAnsi,
} from './parse'

describe('Git formatter review invariants', () => {
  it('retains every step when a captured all-Git workflow uses broader verbs', () => {
    expect(detectGitIntent(
      'git diff --cached --quiet && git reset --mixed origin/main && git status --short --branch',
    )).toMatchObject({
      kind: 'workflow',
      primaryVerb: 'reset',
      operators: ['&&', '&&'],
      steps: [
        { verb: 'diff' },
        { verb: 'reset' },
        { verb: 'status' },
      ],
    })
    expect(detectGitIntent(
      'git stash push -u -m "snapshot" && git rev-parse HEAD && git stash list -1',
    )).toMatchObject({
      kind: 'workflow',
      primaryVerb: 'stash',
      steps: [{ verb: 'stash' }, { verb: 'rev-parse' }, { verb: 'stash' }],
    })
  })

  it.each([
    'git commit -m "checkpoint" | cat',
    'git commit -m "checkpoint" || git status',
    'git commit -m "checkpoint" & git status',
    'git commit -m "checkpoint" > commit.log',
    'git commit -m "checkpoint"\nprintf "unrelated output"',
  ])('declines a commit whose top-level shell program is not solely Git: %s', command => {
    expect(detectGitIntent(command)).toBeNull()
  })

  it('does not mistake shell-looking text inside commit messages for composition', () => {
    expect(detectGitIntent('git commit -m "docs: explain a | b & c > d"')).toMatchObject({
      kind: 'commit',
      message: 'docs: explain a | b & c > d',
    })
    expect(detectGitIntent("git commit -m \"$(cat <<'EOF'\nsubject\nEOF\n)\"")).toMatchObject({
      kind: 'commit',
    })
    expect(detectGitIntent("git add -A && git commit -m \"$(cat <<'EOF'\nsubject\nEOF\n)\"")).toMatchObject({
      kind: 'workflow',
      primaryVerb: 'commit',
      steps: [{ verb: 'add' }, { verb: 'commit' }],
    })
  })

  it.each([
    'git diff $(printf -- --stat)',
    'git status $(printf -- --porcelain)',
    'git commit -m "$(printf subject)"',
    'git diff `printf -- --stat`',
    'git commit -m "`printf subject`"',
  ])('declines executable shell substitution that can change Git argv: %s', command => {
    expect(detectGitIntent(command)).toBeNull()
  })

  it('keeps substitution-looking text that single quotes make literal', () => {
    expect(detectGitIntent("git commit -m 'docs: show $(printf literal) and `ticks`'"))
      .toMatchObject({
        kind: 'commit',
        message: 'docs: show $(printf literal) and `ticks`',
      })
  })

  it('treats a successful commit header as stronger evidence than earlier status advice', () => {
    const parsed = parseGitCommit([
      'Changes not staged for commit:',
      '  (use "git add" to update what will be committed)',
      'no changes added to commit',
      '[main abc1234] checkpoint',
      ' 1 file changed, 2 insertions(+)',
    ].join('\n'))

    expect(parsed).toMatchObject({
      noop: false,
      branch: 'main',
      sha: 'abc1234',
      subject: 'checkpoint',
      filesChanged: 1,
      insertions: 2,
    })
  })

  it('drops ignored porcelain entries instead of fabricating two changes', () => {
    expect(parseGitStatus('!! ignored.log\nM  staged.ts\n M modified.ts')).toEqual({
      staged: [{ code: 'M', path: 'staged.ts', oldPath: undefined }],
      modified: [{ code: 'M', path: 'modified.ts', oldPath: undefined }],
      untracked: [],
    })
  })

  it('parses forced push rows with their marker and three-dot range', () => {
    expect(parseGitPush([
      'To github.com:example/repo.git',
      ' + abc1234...def5678 main -> main (forced update)',
    ].join('\n'))).toMatchObject({
      remoteUrl: 'github.com:example/repo.git',
      refs: [{ range: 'abc1234...def5678', ref: 'main -> main (forced update)' }],
    })
  })

  it('strips non-SGR terminal controls before Git line parsing', () => {
    const controlled = '\x1b[?25l\x1b]0;git status\x07\x1b(BOn branch main'
    expect(stripAnsi(controlled)).toBe('On branch main')
    expect(parseGitStatus(stripAnsi(controlled)).branch).toBe('main')
  })
})
