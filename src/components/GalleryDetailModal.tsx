import { useEffect, useCallback, useRef, useState } from 'react'
import type { BackendGalleryRecord } from '../lib/backend'

export default function GalleryDetailModal({
  record,
  records,
  onClose,
  onNavigate,
  canAdmin,
  onDelete,
}: {
  record: BackendGalleryRecord
  records: BackendGalleryRecord[]
  onClose: () => void
  onNavigate: (record: BackendGalleryRecord) => void
  canAdmin: boolean
  onDelete: (record: BackendGalleryRecord) => void
}) {
  const currentIndex = records.findIndex((r) => r.id === record.id)
  const touchStartRef = useRef<{ x: number; y: number } | null>(null)
  const [swipeOffset, setSwipeOffset] = useState(0)
  const [isSwiping, setIsSwiping] = useState(false)

  const goTo = useCallback((dir: -1 | 1) => {
    const nextIdx = currentIndex + dir
    if (nextIdx >= 0 && nextIdx < records.length) {
      onNavigate(records[nextIdx])
    }
  }, [currentIndex, records, onNavigate])

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      if (e.key === 'ArrowLeft') goTo(-1)
      if (e.key === 'ArrowRight') goTo(1)
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [onClose, goTo])

  const handleTouchStart = (e: React.TouchEvent) => {
    touchStartRef.current = { x: e.touches[0].clientX, y: e.touches[0].clientY }
    setIsSwiping(true)
  }

  const handleTouchMove = (e: React.TouchEvent) => {
    if (!touchStartRef.current) return
    const dx = e.touches[0].clientX - touchStartRef.current.x
    setSwipeOffset(dx)
  }

  const handleTouchEnd = () => {
    setIsSwiping(false)
    if (Math.abs(swipeOffset) > 60) {
      goTo(swipeOffset > 0 ? -1 : 1)
    }
    setSwipeOffset(0)
    touchStartRef.current = null
  }

  const handleDownload = async () => {
    try {
      const res = await fetch(record.outputUrl, { credentials: 'include' })
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `gallery-${record.id}.${blob.type.split('/')[1] || 'png'}`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
    } catch {}
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={onClose}>
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/20 dark:bg-black/40 backdrop-blur-md" />

      {/* Modal */}
      <div
        className="relative max-w-5xl w-full max-h-[90vh] overflow-hidden flex flex-col md:flex-row bg-white/90 dark:bg-gray-900/90 backdrop-blur-xl border border-white/50 dark:border-white/[0.08] rounded-2xl md:rounded-3xl shadow-[0_8px_40px_rgb(0,0,0,0.12)] dark:shadow-[0_8px_40px_rgb(0,0,0,0.4)] ring-1 ring-black/5 dark:ring-white/10"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Image area */}
        <div
          className="relative flex-1 flex items-center justify-center bg-black/5 dark:bg-black/20 min-h-[40vh] md:min-h-0 overflow-hidden"
          onTouchStart={handleTouchStart}
          onTouchMove={handleTouchMove}
          onTouchEnd={handleTouchEnd}
        >
          {/* Nav arrows (desktop) */}
          {currentIndex > 0 && (
            <button
              onClick={() => goTo(-1)}
              className="hidden md:flex absolute left-3 z-10 w-10 h-10 items-center justify-center rounded-full bg-black/10 dark:bg-white/10 hover:bg-black/20 dark:hover:bg-white/20 text-gray-700 dark:text-white transition"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
              </svg>
            </button>
          )}
          {currentIndex < records.length - 1 && (
            <button
              onClick={() => goTo(1)}
              className="hidden md:flex absolute right-3 z-10 w-10 h-10 items-center justify-center rounded-full bg-black/10 dark:bg-white/10 hover:bg-black/20 dark:hover:bg-white/20 text-gray-700 dark:text-white transition"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              </svg>
            </button>
          )}

          <img
            src={record.outputUrl}
            className={`max-h-[60vh] md:max-h-[80vh] max-w-full object-contain select-none ${record.deleted ? 'opacity-45 grayscale' : ''}`}
            alt=""
            style={{
              transform: isSwiping ? `translateX(${swipeOffset}px)` : undefined,
              transition: isSwiping ? 'none' : 'transform 0.2s ease',
            }}
            draggable={false}
          />
        </div>

        {/* Info panel */}
        <div className="w-full md:w-80 lg:w-96 flex flex-col border-t md:border-t-0 md:border-l border-gray-200 dark:border-white/[0.08] bg-white/50 dark:bg-gray-900/50">
          {/* Top bar */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 dark:border-white/[0.08]">
            <span className="text-xs text-gray-400 dark:text-gray-500">{currentIndex + 1} / {records.length}</span>
            <div className="flex items-center gap-1">
              <button
                onClick={handleDownload}
                className="p-2 rounded-full hover:bg-black/5 dark:hover:bg-white/10 text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 transition"
                title="下载"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                </svg>
              </button>
              {canAdmin && !record.deleted && (
                <button
                  onClick={() => onDelete(record)}
                  className="p-2 rounded-full hover:bg-red-50 dark:hover:bg-red-950/30 text-gray-500 dark:text-gray-400 hover:text-red-500 dark:hover:text-red-400 transition"
                  title="删除"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                  </svg>
                </button>
              )}
              <button
                onClick={onClose}
                className="p-2 rounded-full hover:bg-black/5 dark:hover:bg-white/10 text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 transition"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          </div>

          {/* Info content */}
          <div className="flex-1 overflow-y-auto p-4 space-y-3">
            <div>
              <p className="text-sm text-gray-900 dark:text-white leading-relaxed">{record.prompt || '(无提示词)'}</p>
            </div>
            {record.revisedPrompt && (
              <div>
                <p className="text-[10px] uppercase tracking-wider text-gray-400 dark:text-gray-500 mb-1">改写提示词</p>
                <p className="text-xs text-gray-600 dark:text-gray-300 leading-relaxed">{record.revisedPrompt}</p>
              </div>
            )}
            <div className="pt-2 border-t border-gray-100 dark:border-white/[0.06] space-y-2">
              <div className="flex items-center justify-between text-xs">
                <span className="text-gray-400 dark:text-gray-500">用户</span>
                <span className="text-gray-700 dark:text-gray-300">{record.username}</span>
              </div>
              <div className="flex items-center justify-between text-xs">
                <span className="text-gray-400 dark:text-gray-500">模型</span>
                <span className="text-gray-700 dark:text-gray-300">{record.apiModel || '-'}</span>
              </div>
              <div className="flex items-center justify-between text-xs">
                <span className="text-gray-400 dark:text-gray-500">时间</span>
                <span className="text-gray-700 dark:text-gray-300">{new Date(record.createdAt).toLocaleString()}</span>
              </div>
              {record.deleted && (
                <div className="flex items-center justify-between text-xs">
                  <span className="text-gray-400 dark:text-gray-500">状态</span>
                  <span className="text-red-500">已删除</span>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
