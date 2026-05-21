import { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import { deleteGalleryResult, listGallery, listUsers } from '../lib/backend'
import type { BackendGalleryRecord, BackendUser } from '../lib/backend'
import GalleryDetailModal from './GalleryDetailModal'

export default function GalleryPage({ user, onBack }: { user: BackendUser | null; onBack: () => void }) {
  const [records, setRecords] = useState<BackendGalleryRecord[]>([])
  const [users, setUsers] = useState<string[]>([])
  const [mode, setMode] = useState<'mine' | 'all' | 'user'>('mine')
  const [owner, setOwner] = useState('')
  const [page, setPage] = useState(1)
  const [pageInfo, setPageInfo] = useState({ page: 1, pageSize: 40, total: 0, totalPages: 1 })
  const [selected, setSelected] = useState<BackendGalleryRecord | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [showFilters, setShowFilters] = useState(false)
  const loaderRef = useRef<HTMLDivElement>(null)

  const canAdmin = user?.role === 'admin'
  const query = useMemo(() => {
    if (!canAdmin || mode === 'mine') return undefined
    if (mode === 'all') return { mode: 'all' as const }
    return owner ? { owner } : undefined
  }, [canAdmin, mode, owner])

  const refresh = async (resetPage = false) => {
    setLoading(true)
    try {
      const targetPage = resetPage ? 1 : page
      const res = await listGallery({ ...query, page: targetPage, pageSize: 40 })
      if (resetPage || targetPage === 1) {
        setRecords(res.results)
      } else {
        setRecords((prev) => {
          const ids = new Set(prev.map((r) => r.id))
          return [...prev, ...res.results.filter((r) => !ids.has(r.id))]
        })
      }
      setPageInfo({ page: res.page, pageSize: res.pageSize, total: res.total, totalPages: res.totalPages })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    setRecords([])
    setPage(1)
    refresh(true).catch(() => {})
  }, [query?.mode, query?.owner])

  useEffect(() => {
    if (page > 1) refresh().catch(() => {})
  }, [page])

  // Infinite scroll
  useEffect(() => {
    if (!loaderRef.current) return
    const observer = new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting && !loading && page < pageInfo.totalPages) {
        setPage((p) => p + 1)
      }
    }, { rootMargin: '200px' })
    observer.observe(loaderRef.current)
    return () => observer.disconnect()
  }, [loading, page, pageInfo.totalPages])

  useEffect(() => {
    if (!canAdmin) return
    listUsers()
      .then((res) => setUsers(res.users.map((item) => item.username)))
      .catch(() => {})
  }, [canAdmin])

  const handleDelete = async (record: BackendGalleryRecord) => {
    await deleteGalleryResult(record.id)
    setRecords((prev) => prev.map((r) => r.id === record.id ? { ...r, deleted: true, deletedAt: Date.now() } : r))
    if (selected?.id === record.id) {
      setSelected({ ...record, deleted: true, deletedAt: Date.now() })
    }
  }

  return (
    <main className="min-h-screen bg-gray-50 text-gray-900 dark:bg-gray-950 dark:text-gray-100">
      {/* Header */}
      <header className="sticky top-0 z-30 border-b border-gray-200 bg-white/80 backdrop-blur-lg dark:border-white/[0.08] dark:bg-gray-950/80">
        <div className="mx-auto flex max-w-7xl items-center gap-3 px-4 py-3">
          <button onClick={onBack} className="p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-white/[0.06] transition">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
          </button>
          <div className="flex-1">
            <h1 className="text-base font-bold">Gallery</h1>
            <p className="text-xs text-gray-400 dark:text-gray-500">{pageInfo.total} 张图片</p>
          </div>
          {canAdmin && (
            <button
              onClick={() => setShowFilters(!showFilters)}
              className={`p-2 rounded-lg transition ${showFilters ? 'bg-blue-50 text-blue-500 dark:bg-blue-500/10' : 'hover:bg-gray-100 dark:hover:bg-white/[0.06] text-gray-500'}`}
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z" />
              </svg>
            </button>
          )}
        </div>
        {/* Filter bar (collapsible) */}
        {canAdmin && showFilters && (
          <div className="px-4 pb-3 flex flex-wrap items-center gap-2 border-t border-gray-100 dark:border-white/[0.04] pt-3">
            <button onClick={() => setMode('mine')} className={`rounded-full px-3 py-1.5 text-xs font-medium transition ${mode === 'mine' ? 'bg-blue-500 text-white shadow-sm' : 'bg-gray-100 text-gray-600 hover:bg-gray-200 dark:bg-white/[0.06] dark:text-gray-300 dark:hover:bg-white/[0.1]'}`}>我的</button>
            <button onClick={() => setMode('all')} className={`rounded-full px-3 py-1.5 text-xs font-medium transition ${mode === 'all' ? 'bg-blue-500 text-white shadow-sm' : 'bg-gray-100 text-gray-600 hover:bg-gray-200 dark:bg-white/[0.06] dark:text-gray-300 dark:hover:bg-white/[0.1]'}`}>全部</button>
            <select value={owner} onChange={(e) => { setOwner(e.target.value); setMode('user') }} className="rounded-full border border-gray-200 bg-white px-3 py-1.5 text-xs dark:border-white/[0.08] dark:bg-gray-900">
              <option value="">选择用户</option>
              {users.map((item) => <option key={item} value={item}>{item}</option>)}
            </select>
          </div>
        )}
      </header>

      {/* Content */}
      <div className="mx-auto max-w-7xl px-3 py-4 sm:px-4">
        {error && <div className="mb-4 rounded-xl bg-red-50 px-4 py-3 text-sm text-red-500 dark:bg-red-500/10">{error}</div>}

        {/* Responsive grid: 2 cols mobile → 3 tablet → 4 desktop → 5 wide */}
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 sm:gap-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-5">
          {records.map((record) => (
            <button
              key={record.id}
              onClick={() => setSelected(record)}
              className={`group relative overflow-hidden rounded-xl border bg-white text-left shadow-sm transition-all duration-200 hover:shadow-lg hover:scale-[1.02] dark:bg-gray-900 ${
                record.deleted ? 'border-red-300 dark:border-red-500/40' : 'border-gray-200/60 dark:border-white/[0.06]'
              }`}
            >
              <div className="aspect-square bg-gray-100 dark:bg-black/20 relative overflow-hidden">
                <img
                  src={record.thumbnailUrl}
                  className={`h-full w-full object-cover transition-transform duration-300 group-hover:scale-105 ${record.deleted ? 'opacity-35 grayscale' : ''}`}
                  alt=""
                  loading="lazy"
                />
                {record.deleted && (
                  <div className="absolute inset-0 flex items-center justify-center bg-black/30">
                    <span className="rounded-full bg-red-500/80 px-2 py-0.5 text-[10px] font-bold text-white">已删除</span>
                  </div>
                )}
                {/* Hover overlay (desktop) */}
                <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-200 hidden sm:flex flex-col justify-end p-2">
                  <p className="text-[11px] text-white/90 line-clamp-2 leading-tight">{record.prompt || '(无提示词)'}</p>
                </div>
              </div>
              {/* Mobile: always show prompt below */}
              <div className="p-2 sm:hidden">
                <p className="line-clamp-1 text-[11px] text-gray-600 dark:text-gray-400 leading-tight">{record.prompt || '(无提示词)'}</p>
              </div>
            </button>
          ))}
        </div>

        {/* Loading & infinite scroll trigger */}
        <div ref={loaderRef} className="py-8 flex items-center justify-center">
          {loading && (
            <svg className="w-6 h-6 text-gray-400 animate-spin" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
          )}
          {!loading && records.length > 0 && page >= pageInfo.totalPages && (
            <p className="text-xs text-gray-400 dark:text-gray-500">已加载全部 {pageInfo.total} 张图片</p>
          )}
          {!loading && records.length === 0 && (
            <div className="text-center py-12">
              <svg className="w-12 h-12 mx-auto mb-3 text-gray-200 dark:text-gray-700" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
              </svg>
              <p className="text-sm text-gray-400 dark:text-gray-500">暂无图片</p>
            </div>
          )}
        </div>
      </div>

      {/* Detail Modal */}
      {selected && (
        <GalleryDetailModal
          record={selected}
          records={records}
          onClose={() => setSelected(null)}
          onNavigate={(r) => setSelected(r)}
          canAdmin={canAdmin}
          onDelete={handleDelete}
        />
      )}
    </main>
  )
}
