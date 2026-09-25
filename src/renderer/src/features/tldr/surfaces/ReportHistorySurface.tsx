import { useAppStore } from '@renderer/app-state/hooks'
import { useWorkspaceContext } from '@renderer/workspace/WorkspaceContext'
import { ReportHistoryModal } from '../ReportHistoryModal'

export function ReportHistorySurface() {
  const workspace = useWorkspaceContext()
  const history = useAppStore(state => state.reportHistory)
  const close = useAppStore(state => state.closeReportHistory)
  // `kind` falls back to 'tldr' only while closed, where it is never shown.
  return <ReportHistoryModal open={history !== null} kind={history?.kind ?? 'tldr'} sessionId={history?.sessionId ?? null} workspace={workspace} onClose={close} />
}
