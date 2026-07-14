import { memo } from 'react'

import {
  isSlashCommandText,
  parseLocalCommandStdout,
  parseSlashCommandEnvelope,
} from '@providers/claude/renderer/extractors'

import { MarkerRow } from '@renderer/features/feed/ui/MarkerRow'
import { TextProse } from '@renderer/features/feed/ui/markdown'
import { OutputWell } from '@renderer/features/feed/ui/kit/OutputWell'
import { UserBand } from '@renderer/features/feed/ui/rows/primitives'

// Slash-command rendering (spec §6). Claude Code records a slash
// invocation as a user text block full of XML-ish tags —
// <command-name>/foo</command-name> etc. — which the feed used to
// paint as literal tag soup inside the user's prompt bubble (audit
// gap #6, one of the ugliest everyday surfaces). Two row shapes:
//
//   ❯ /model  model            ← invocation: name pill + message/args
//   ⎿ Set model to Fable 5…    ← stdout record (SEPARATE user entry,
//                                 may carry ANSI — real transcripts do)
//
// The stdout row is muted and band-less on purpose: it is command
// OUTPUT the CLI echoed, not something the user typed — wrapping it
// in the user band would misattribute it.

export const SlashCommandRow = memo(function SlashCommandRow({ text }: { text: string }) {
  const envelope = parseSlashCommandEnvelope(text)
  if (envelope) {
    return (
      <UserBand>
        <MarkerRow marker="❯">
          <div className="flex flex-col gap-1">
            <div className="flex flex-wrap items-baseline gap-x-2">
              <span className="font-code text-[13px] leading-[1.65] text-accent border border-border rounded px-1.5 py-px">
                {envelope.name}
              </span>
              {envelope.message && envelope.message !== envelope.name.replace(/^\//, '') ? (
                <span className="text-ink-dim text-[12px] italic">{envelope.message}</span>
              ) : null}
            </div>
            {envelope.args ? <TextProse text={envelope.args} /> : null}
          </div>
        </MarkerRow>
      </UserBand>
    )
  }

  const stdout = parseLocalCommandStdout(text)
  if (stdout !== null) {
    if (!stdout.trim()) return null
    return <OutputWell text={stdout} isError={false} ansi />
  }

  // Defensive: isSlashCommandText matched but neither tag parsed —
  // fall back to plain user text so nothing ever vanishes.
  return (
    <UserBand>
      <MarkerRow marker="❯">
        <TextProse text={text} />
      </MarkerRow>
    </UserBand>
  )
})

export { isSlashCommandText }
