import { describe, expect, it } from 'vitest'

import { summarizeLanes } from 'hermes-headless'
import { recordingFor } from 'hermes-headless/testing/corpus'

import { hermesThreadChoices, laneLabel } from './hermesThreadChoices'

// The picker's rows from the REAL lane listing: recorded T8 (hermes-headless
// corpus, v0.22.0), the owner's plain DM with the bot plus DM topic 7. Both
// rows carry the same display name, "Tester", which is the case the labels
// exist for.
const listing = recordingFor('T8', 'v0.22.0')
  .filter((entry) => entry.dir === 'in' && entry.kind === 'http' && /\/api\/sessions\?/.test(String(entry.frame.url)) && entry.frame.status === 200)
  .at(-1)!.frame.body as { sessions: Parameters<typeof summarizeLanes>[0] }
const lanes = summarizeLanes(listing.sessions).map(({ headId: _headId, ...lane }) => lane)
const DM = 'agent:main:telegram:dm:111'
const TOPIC = 'agent:main:telegram:dm:111:7'

describe('Hermes thread picker rows', () => {
  it('tells the plain chat from its topic even though both have the same name', () => {
    const labels = lanes.map(laneLabel)
    expect(labels).toEqual(['Direct chat topic 7 · Tester', 'Direct chat · Tester'])
    expect(new Set(labels).size).toBe(labels.length)
  })

  it('offers a separate chat first and marks the thread the pane follows', () => {
    const rows = hermesThreadChoices(lanes, DM)
    expect(rows.map((row) => [row.laneKey, row.current])).toEqual([
      [null, false],
      [TOPIC, false],
      [DM, true],
    ])
  })

  it('marks "Separate chat" as current for a pane that follows no thread', () => {
    expect(hermesThreadChoices(lanes, null).filter((row) => row.current).map((row) => row.laneKey)).toEqual([null])
  })

  it('keeps a followed thread the listing no longer returns, so the pane never looks unattached', () => {
    // Mechanical mutation of the recording: the plain DM dropped from the
    // listing (it fell out of the 100 most recent rows).
    const rows = hermesThreadChoices(lanes.filter((lane) => lane.sessionKey !== DM), DM)
    expect(rows.map((row) => [row.laneKey, row.current])).toEqual([
      [null, false],
      [DM, true],
      [TOPIC, false],
    ])
  })
})
