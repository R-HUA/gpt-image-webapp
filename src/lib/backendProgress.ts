import type { BackendJobProgress } from '../types'

export function getBackendProcessedCount(progress: BackendJobProgress | null | undefined): number {
  if (!progress) return 0
  return Math.min(progress.total, progress.completed + progress.failed + (progress.skipped || 0))
}
