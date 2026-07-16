import { utilityProcess } from 'electron'
import type { UtilityProcess } from 'electron'
import type { Readable } from 'node:stream'

import type {
  ParentToWorkerMessage,
  WorkerToParentMessage,
  WorkflowWorkerHandle,
  WorkflowWorkerLauncher,
  WorkflowWorkerLaunchOptions,
} from 'workflow-mcp'

/**
 * Electron-native worker launcher for the untrusted workflow evaluator.
 *
 * WHY utilityProcess instead of child_process.fork: packaged Agent Code does
 * not promise that Electron can be relaunched as a generic Node executable;
 * hardened distributions can disable that behavior through the runAsNode
 * fuse. utilityProcess.fork is Electron's supported equivalent, uses a signed
 * helper in the app bundle, and speaks structured-clone messages through
 * process.parentPort. The package keeps child_process as its standalone Node
 * adapter, while this small boundary preserves identical scheduler semantics.
 */
export class ElectronWorkflowWorkerLauncher implements WorkflowWorkerLauncher {
  launch(options: WorkflowWorkerLaunchOptions): WorkflowWorkerHandle {
    const child = utilityProcess.fork(options.workerFilePath, [], {
      env: options.env,
      stdio: ['ignore', 'ignore', 'pipe'],
      serviceName: 'Agent Code Workflow Evaluator',
    })
    return new ElectronWorkflowWorkerHandle(child)
  }
}

class ElectronWorkflowWorkerHandle implements WorkflowWorkerHandle {
  readonly stderr: Readable | undefined

  constructor(private readonly child: UtilityProcess) {
    this.stderr = child.stderr === null ? undefined : child.stderr as Readable
  }

  postMessage(message: ParentToWorkerMessage): void {
    if (!this.isRunning()) {
      throw new Error('Cannot send workflow message after Electron worker exit')
    }
    this.child.postMessage(message)
  }

  onMessage(listener: (message: WorkerToParentMessage) => void): () => void {
    const onMessage = (message: unknown): void => {
      listener(message as WorkerToParentMessage)
    }
    this.child.on('message', onMessage)
    return () => this.child.off('message', onMessage)
  }

  onExit(listener: (exit: { code: number | null; signal: string | null }) => void): () => void {
    // Electron's UtilityProcess exit event reports only the waitpid/GetExitCode
    // result. Preserve the package's cross-platform shape with signal:null
    // rather than inventing a signal from the numeric code.
    const onExit = (code: number): void => listener({ code, signal: null })
    this.child.on('exit', onExit)
    return () => this.child.off('exit', onExit)
  }

  onError(listener: (error: Error) => void): () => void {
    // UtilityProcess's error event is a V8 fatal-error report, not Node's
    // ordinary Error object. Collapse it at this adapter boundary so the
    // platform-neutral scheduler never imports Electron-only event shapes.
    const onError = (type: 'FatalError', location: string, report: string): void => {
      const error = new Error(`${type} in workflow worker at ${location}`)
      error.name = 'WorkflowWorkerFatalError'
      if (report.length > 0) error.stack = report
      listener(error)
    }
    // Electron 31 documents and implements this experimental event, but its
    // generated top-level UtilityProcess type omits the overload in some
    // module-resolution modes even though electron.d.ts contains it in the
    // Main namespace. Keep the narrow cast beside the one affected event; do
    // not weaken the rest of the process handle to EventEmitter/any.
    const fatalEvents = this.child as unknown as UtilityProcessFatalErrorEvents
    fatalEvents.on('error', onError)
    return () => fatalEvents.off('error', onError)
  }

  isRunning(): boolean {
    return this.child.pid !== undefined
  }

  terminate(): void {
    if (this.isRunning()) this.child.kill()
  }
}

type UtilityProcessFatalErrorEvents = {
  on(
    event: 'error',
    listener: (type: 'FatalError', location: string, report: string) => void,
  ): void
  off(
    event: 'error',
    listener: (type: 'FatalError', location: string, report: string) => void,
  ): void
}
