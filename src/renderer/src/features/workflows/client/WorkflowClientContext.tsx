import { createContext, useContext } from 'react'
import type { ReactNode } from 'react'

import {
  unavailableWorkflowClient,
  type WorkflowClient,
} from './WorkflowClient'

const WorkflowClientContext = createContext<WorkflowClient>(unavailableWorkflowClient)

export function WorkflowClientProvider({
  value,
  children,
}: {
  value: WorkflowClient
  children: ReactNode
}): React.JSX.Element {
  return (
    <WorkflowClientContext.Provider value={value}>
      {children}
    </WorkflowClientContext.Provider>
  )
}

export function useWorkflowClient(): WorkflowClient {
  return useContext(WorkflowClientContext)
}
