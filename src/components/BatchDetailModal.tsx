import { useEffect, useState } from 'react'
import type { TaskRecord } from '../types'
import { useStore, ensureImageThumbnailCached, subscribeImageThumbnail, retryBatchItem, skipBatchSubRequest } from '../store'

function BatchItemCard({ task, batchOwner }: { task: TaskRecord; batchOwner: TaskRecord | null }) {
  const [thumbSrc, setThumbSrc] = useState('')
  const setLightboxImageId = useStore((s) => s.setLightboxImageId)
  const setDetailTaskId = useStore((s) => s.setDetailTaskId)

  useEffect(() => {
    let cancelled = false
    const imageId = task.outputImages?.[0]
    let unsubscribe: (() => void) | undefined

    if (imageId) {
      unsubscribe = subscribeImageThumbnail(imageId, (thumb) => {
        if (!cancelled) setThumbSrc(thumb.dataUrl)
      })
      ensureImageThumbnailCached(imageId).then((thumb) => {
        if (!cancelled && thumb) setThumbSrc(thumb.dataUrl)
      }).catch(() => {})
    }

    return () => {
      cancelled = true
      unsubscribe?.()
    }
  }, [task.outputImages])

  const statusConfig = {
    done: { label: '完成', bg: 'bg-green-100 dark:bg-green-500/10', text: 'text-green-600 dark:text-green-400', dot: 'bg-green-500' },
    running: { label: '生成中', bg: 'bg-blue-100 dark:bg-blue-500/10', text: 'text-blue-600 dark:text-blue-400', dot: 'bg-blue-500' },
    queued: { label: '排队中', bg: 'bg-gray-100 dark:bg-gray-500/10', text: 'text-gray-600 dark:text-gray-400', dot: 'bg-gray-400' },
    error: { label: '失败', bg: 'bg-red-100 dark:bg-red-500/10', text: 'text-red-600 dark:text-red-400', dot: 'bg-red-500' },
    cancelled: { label: '已取消', bg: 'bg-orange-100 dark:bg-orange-500/10', text: 'text-orange-600 dark:text-orange-400', dot: 'bg-orange-500' },
  }

  const status = statusConfig[task.status] || statusConfig.queued
  const canRetry = task.status === 'error'
  const currentRunningIndex = batchOwner?.backendProgress?.current ?? (batchOwner?.status === 'running' ? 1 : 0)
  const isCurrentlyRunning = task.batchIndex === currentRunningIndex && (task.status === 'queued' || task.status === 'running')
  const isQueued = task.batchIndex && task.batchIndex > currentRunningIndex && (task.status === 'queued' || task.status === 'running')
  const canCancel = isQueued && batchOwner && task.batchIndex

  return (
    <div className={`flex items-center gap-3 rounded-2xl border p-3 transition hover:shadow-sm hover:border-gray-300 dark:hover:border-white/20 ${
      task.status === 'running' ? 'border-blue-300 dark:border-blue-500/40 shadow-sm' :
      task.status === 'error' ? 'border-red-200 dark:border-red-500/30' :
      'border-gray-200 dark:border-white/[0.08]'
    } bg-white/80 dark:bg-gray-900/80 backdrop-blur-sm`}>
      {/* Thumbnail / Status icon */}
      <div className="w-14 h-14 rounded-xl overflow-hidden bg-gray-100 dark:bg-black/20 flex-shrink-0 flex items-center justify-center ring-1 ring-black/5 dark:ring-white/5">
        {task.status === 'done' && thumbSrc ? (
          <img
            src={thumbSrc}
            className="w-full h-full object-cover cursor-pointer"
            alt=""
            onClick={() => {
              if (task.outputImages?.[0]) {
                setLightboxImageId(task.outputImages[0], task.outputImages)
              }
            }}
          />
        ) : task.status === 'running' ? (
          <svg className="w-6 h-6 text-blue-400 animate-spin" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
        ) : task.status === 'error' ? (
          <svg className="w-6 h-6 text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
        ) : task.status === 'cancelled' ? (
          <svg className="w-6 h-6 text-orange-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        ) : (
          <svg className="w-6 h-6 text-gray-300 dark:text-gray-600 animate-queue-breathe" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
        )}
      </div>

      {/* Info */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1">
          <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium ${status.bg} ${status.text}`}>
            <span className={`w-1.5 h-1.5 rounded-full ${status.dot}`} />
            {status.label}
          </span>
          {task.batchIndex && (
            <span className="text-[10px] text-gray-400">#{task.batchIndex}</span>
          )}
        </div>
        {task.error && task.status === 'error' && (
          <p className="text-xs text-red-500 dark:text-red-400 line-clamp-2">{task.error}</p>
        )}
        {(task.status === 'done' || task.status === 'error') && (
          <button
            onClick={() => setDetailTaskId(task.id)}
            className="text-xs text-blue-500 hover:text-blue-600 transition"
          >
            查看详情
          </button>
        )}
      </div>

      {/* Actions */}
      <div className="flex items-center gap-1 flex-shrink-0">
        {canRetry && (
          <button
            onClick={() => retryBatchItem(task)}
            className="p-1.5 rounded-lg hover:bg-blue-50 dark:hover:bg-blue-950/30 text-gray-400 hover:text-blue-500 transition"
            title="重试"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
          </button>
        )}
        {isCurrentlyRunning && (
          <button
            disabled
            className="p-1.5 rounded-lg text-gray-300 dark:text-gray-700 cursor-not-allowed"
            title="无法取消正在生成的子请求"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        )}
        {canCancel && (
          <button
            onClick={() => skipBatchSubRequest(batchOwner!, task.batchIndex!)}
            className="p-1.5 rounded-lg hover:bg-red-50 dark:hover:bg-red-950/30 text-gray-400 hover:text-red-500 transition"
            title="取消"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        )}
      </div>
    </div>
  )
}

export default function BatchDetailModal() {
  const batchDetailBatchId = useStore((s) => s.batchDetailBatchId)
  const setBatchDetailBatchId = useStore((s) => s.setBatchDetailBatchId)
  const tasks = useStore((s) => s.tasks)
  const [showHidden, setShowHidden] = useState(false)

  if (!batchDetailBatchId) return null

  const allBatchTasks = tasks
    .filter((t) => t.batchId === batchDetailBatchId)
    .sort((a, b) => (a.batchIndex || 0) - (b.batchIndex || 0))

  const visibleTasks = showHidden ? allBatchTasks : allBatchTasks.filter((t) => !t.hiddenByRetry)
  const hiddenCount = allBatchTasks.filter((t) => t.hiddenByRetry).length
  const batchOwner = allBatchTasks.find((t) => t.backendJobOwner) || null

  const doneCount = visibleTasks.filter((t) => t.status === 'done' && !t.hiddenByRetry).length
  const errorCount = visibleTasks.filter((t) => t.status === 'error' && !t.hiddenByRetry).length
  const runningCount = visibleTasks.filter((t) => (t.status === 'running' || t.status === 'queued') && !t.hiddenByRetry).length
  const cancelledCount = visibleTasks.filter((t) => t.status === 'cancelled' && !t.hiddenByRetry).length
  const total = allBatchTasks.filter((t) => !t.hiddenByRetry).length

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50 backdrop-blur-sm"
      onClick={() => setBatchDetailBatchId(null)}
    >
      <div
        className="w-full sm:max-w-lg max-h-[85vh] sm:max-h-[80vh] bg-white/90 dark:bg-gray-900/90 backdrop-blur-xl border border-white/50 dark:border-white/[0.08] rounded-t-2xl sm:rounded-3xl overflow-hidden flex flex-col shadow-[0_8px_40px_rgb(0,0,0,0.12)] dark:shadow-[0_8px_40px_rgb(0,0,0,0.4)] ring-1 ring-black/5 dark:ring-white/10 pb-[max(0px,var(--safe-area-bottom))]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200 dark:border-white/[0.08] bg-white/50 dark:bg-gray-900/50">
          <div>
            <h2 className="text-base font-bold text-gray-900 dark:text-white">批次详情</h2>
            <div className="flex items-center gap-3 mt-1 text-xs text-gray-500 dark:text-gray-400">
              <span className="flex items-center gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-green-500" />
                {doneCount} 完成
              </span>
              {errorCount > 0 && (
                <span className="flex items-center gap-1">
                  <span className="w-1.5 h-1.5 rounded-full bg-red-500" />
                  {errorCount} 失败
                </span>
              )}
              {runningCount > 0 && (
                <span className="flex items-center gap-1">
                  <span className="w-1.5 h-1.5 rounded-full bg-blue-500" />
                  {runningCount} 进行中
                </span>
              )}
              {cancelledCount > 0 && (
                <span className="flex items-center gap-1">
                  <span className="w-1.5 h-1.5 rounded-full bg-orange-500" />
                  {cancelledCount} 已取消
                </span>
              )}
              <span className="text-gray-400">共 {total} 项</span>
            </div>
          </div>
          <button
            onClick={() => setBatchDetailBatchId(null)}
            className="p-2 rounded-full hover:bg-black/5 dark:hover:bg-white/10 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 transition"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Progress bar */}
        {total > 0 && (
          <div className="h-1.5 bg-gray-200 dark:bg-gray-800 rounded-full mx-4 mt-3 overflow-hidden">
            <div
              className="h-full bg-gray-900 dark:bg-white transition-all duration-500 rounded-full"
              style={{ width: `${(doneCount / total) * 100}%` }}
            />
          </div>
        )}

        {/* Task list */}
        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-2">
          {visibleTasks.map((task) => (
            <div key={task.id} className={task.hiddenByRetry ? 'opacity-50' : ''}>
              <BatchItemCard task={task} batchOwner={batchOwner} />
              {task.hiddenByRetry && (
                <div className="ml-14 mt-0.5 text-[10px] text-gray-400 dark:text-gray-500">已被重试替代</div>
              )}
            </div>
          ))}
        </div>

        {/* Footer */}
        {hiddenCount > 0 && (
          <div className="px-4 py-3 border-t border-gray-200 dark:border-white/[0.08] bg-white dark:bg-gray-900">
            <button
              onClick={() => setShowHidden(!showHidden)}
              className="text-xs text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 transition"
            >
              {showHidden ? '隐藏已替代的任务' : `显示 ${hiddenCount} 个已替代的任务`}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
