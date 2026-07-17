import { defineView } from '@shared/conditions-core/view'
import type { ClaudeCompactionState } from '@shared/types/providerConditions'
import { CompactionStrip } from './CompactionStrip'

export const compactionView = defineView<'claude.compaction', ClaudeCompactionState>({
  kind: 'claude.compaction',
  layout: 'strip',
  attention: state => (state?.phase === 'error' ? 'ERROR' : null),
  Component: ({ state }) => (
    <CompactionStrip compaction={state?.visible && state.phase ? state : null} />
  ),
})
