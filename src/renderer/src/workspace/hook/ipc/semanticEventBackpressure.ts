// Kept as a compatibility import path for renderer tests and nearby hook code. The implementation
// is shared because renderer-only coalescing cannot prevent raw Electron IPC deserialization.
export {
  SemanticEventBackpressureQueue,
  type CoalescedSemanticEvent,
} from '@shared/sessionFeed/semanticEventBackpressure'
