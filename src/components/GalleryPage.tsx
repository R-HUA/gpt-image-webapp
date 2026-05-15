import { useEffect, useMemo, useState } from 'react'
import { deleteGalleryResult, listGallery, listUsers } from '../lib/backend'
import type { BackendGalleryRecord, BackendUser } from '../lib/backend'

export default function GalleryPage({ user, onBack }: { user: BackendUser | null; onBack: () => void }) {
  const [records, setRecords] = useState<BackendGalleryRecord[]>([])
  const [users, setUsers] = useState<string[]>([])
  const [mode, setMode] = useState<'mine' | 'all' | 'user'>('mine')
  const [owner, setOwner] = useState('')
  const [page, setPage] = useState(1)
  const [pageInfo, setPageInfo] = useState({ page: 1, pageSize: 40, total: 0, totalPages: 1 })
  const [selected, setSelected] = useState<BackendGalleryRecord | null>(null)
  const [error, setError] = useState('')

  const canAdmin = user?.role === 'admin'
  const query = useMemo(() => {
    if (!canAdmin || mode === 'mine') return undefined
    if (mode === 'all') return { mode: 'all' as const }
    return owner ? { owner } : undefined
  }, [canAdmin, mode, owner])

  const refresh = async () => {
    const res = await listGallery({ ...query, page, pageSize: 40 })
    setRecords(res.results)
    setPageInfo({ page: res.page, pageSize: res.pageSize, total: res.total, totalPages: res.totalPages })
  }

  useEffect(() => {
    refresh().catch((err) => setError(err instanceof Error ? err.message : String(err)))
  }, [query?.mode, query?.owner, page])

  useEffect(() => {
    setPage(1)
  }, [mode, owner])

  useEffect(() => {
    if (!canAdmin) return
    listUsers()
      .then((res) => setUsers(res.users.map((item) => item.username)))
      .catch(() => {})
  }, [canAdmin])

  return (
    <main className="min-h-screen bg-gray-50 text-gray-900 dark:bg-gray-950 dark:text-gray-100">
      <header className="sticky top-0 z-30 border-b border-gray-200 bg-white/80 backdrop-blur dark:border-white/[0.08] dark:bg-gray-950/80">
        <div className="mx-auto flex max-w-7xl items-center gap-3 px-4 py-3">
          <button onClick={onBack} className="rounded-lg px-3 py-2 text-sm hover:bg-gray-100 dark:hover:bg-white/[0.06]">返回</button>
          <h1 className="text-base font-bold">Gallery</h1>
          {canAdmin && (
            <div className="ml-auto flex items-center gap-2">
              <button onClick={() => setMode('mine')} className={`rounded-lg px-3 py-1.5 text-sm ${mode === 'mine' ? 'bg-blue-500 text-white' : 'hover:bg-gray-100 dark:hover:bg-white/[0.06]'}`}>我的</button>
              <button onClick={() => setMode('all')} className={`rounded-lg px-3 py-1.5 text-sm ${mode === 'all' ? 'bg-blue-500 text-white' : 'hover:bg-gray-100 dark:hover:bg-white/[0.06]'}`}>全部</button>
              <select value={owner} onChange={(e) => { setOwner(e.target.value); setMode('user') }} className="rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm dark:border-white/[0.08] dark:bg-gray-900">
                <option value="">选择用户</option>
                {users.map((item) => <option key={item} value={item}>{item}</option>)}
              </select>
            </div>
          )}
        </div>
      </header>
      <div className="mx-auto max-w-7xl px-4 py-5">
        {error && <div className="mb-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-500 dark:bg-red-500/10">{error}</div>}
        <div className="mb-4 flex items-center justify-between text-sm text-gray-500 dark:text-gray-400">
          <span>共 {pageInfo.total} 张，当前第 {pageInfo.page} / {pageInfo.totalPages} 页</span>
          <div className="flex gap-2">
            <button disabled={page <= 1} onClick={() => setPage((v) => Math.max(1, v - 1))} className="rounded-lg border border-gray-200 px-3 py-1.5 disabled:opacity-40 dark:border-white/[0.08]">上一页</button>
            <button disabled={page >= pageInfo.totalPages} onClick={() => setPage((v) => v + 1)} className="rounded-lg border border-gray-200 px-3 py-1.5 disabled:opacity-40 dark:border-white/[0.08]">下一页</button>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
          {records.map((record) => (
            <button
              key={record.id}
              onClick={() => setSelected(record)}
              className={`group relative overflow-hidden rounded-xl border bg-white text-left shadow-sm transition hover:shadow-md dark:bg-gray-900 ${
                record.deleted ? 'border-red-300 dark:border-red-500/40' : 'border-gray-200 dark:border-white/[0.08]'
              }`}
            >
              <div className="aspect-square bg-gray-100 dark:bg-black/20">
                <img src={record.thumbnailUrl} className={`h-full w-full object-cover ${record.deleted ? 'opacity-35 grayscale' : ''}`} alt="" />
              </div>
              {record.deleted && <div className="absolute inset-0 flex items-center justify-center bg-black/30 text-sm font-bold text-white">已删除</div>}
              <div className="p-2">
                <p className="line-clamp-2 text-xs text-gray-700 dark:text-gray-300">{record.prompt || '(无提示词)'}</p>
                {canAdmin && <p className="mt-1 text-[11px] text-gray-400">{record.username}</p>}
              </div>
            </button>
          ))}
        </div>
      </div>
      {selected && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm" onClick={() => setSelected(null)}>
          <div className="max-h-[90vh] w-full max-w-5xl overflow-hidden rounded-2xl bg-white shadow-2xl dark:bg-gray-900" onClick={(e) => e.stopPropagation()}>
            <div className="grid max-h-[90vh] md:grid-cols-[minmax(0,1fr)_340px]">
              <div className="flex min-h-[360px] items-center justify-center bg-black/90">
                <img src={selected.outputUrl} className={`max-h-[90vh] max-w-full object-contain ${selected.deleted ? 'opacity-45 grayscale' : ''}`} alt="" />
              </div>
              <aside className="overflow-y-auto p-5">
                <div className="mb-4 flex items-center justify-between">
                  <h2 className="text-sm font-bold">生成信息</h2>
                  <button onClick={() => setSelected(null)} className="rounded-lg px-2 py-1 text-sm hover:bg-gray-100 dark:hover:bg-white/[0.06]">关闭</button>
                </div>
                <div className="space-y-3 text-sm">
                  <div>
                    <div className="mb-1 text-xs text-gray-400">提示词</div>
                    <p className="whitespace-pre-wrap text-gray-700 dark:text-gray-300">{selected.prompt || '(无提示词)'}</p>
                  </div>
                  {selected.revisedPrompt && (
                    <div>
                      <div className="mb-1 text-xs text-gray-400">改写提示词</div>
                      <p className="whitespace-pre-wrap text-gray-700 dark:text-gray-300">{selected.revisedPrompt}</p>
                    </div>
                  )}
                  <div className="grid grid-cols-2 gap-2 text-xs text-gray-500 dark:text-gray-400">
                    <span>用户：{selected.username}</span>
                    <span>模型：{selected.apiModel || '-'}</span>
                    <span>时间：{new Date(selected.createdAt).toLocaleString()}</span>
                    <span>状态：{selected.deleted ? '已删除' : '正常'}</span>
                  </div>
                  <pre className="max-h-48 overflow-auto rounded-lg bg-gray-50 p-3 text-xs dark:bg-white/[0.03]">{JSON.stringify(selected.params, null, 2)}</pre>
                  {canAdmin && (
                    <button
                      disabled={selected.deleted}
                      onClick={async () => {
                        await deleteGalleryResult(selected.id)
                        await refresh()
                        setSelected({ ...selected, deleted: true, deletedAt: Date.now() })
                      }}
                      className="w-full rounded-xl bg-red-500 px-4 py-2 text-sm text-white disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      删除结果
                    </button>
                  )}
                </div>
              </aside>
            </div>
          </div>
        </div>
      )}
    </main>
  )
}
