import { memo } from 'react'

import { CommandView } from '@providers/shared/renderer/protocols/command/CommandView'
import type { DiscoveryRenderModel } from '@providers/shared/renderer/protocols/discovery/model'

const LABELS: Record<DiscoveryRenderModel['kind'], string> = {
  search: 'Search',
  read: 'Read',
  list: 'List',
}

/**
 * Discovery keeps the battle-tested command/output surface and changes only
 * the semantic headline. Parsing in this component would let React become a
 * second source of routing truth and make the receipt disagree with the DOM.
 */
export const DiscoveryOperationView = memo(function DiscoveryOperationView({
  model,
}: {
  model: DiscoveryRenderModel
}) {
  return <CommandView model={{ ...model.command, label: LABELS[model.kind] }} />
})
