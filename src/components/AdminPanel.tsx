import { useEffect, useState } from 'react'
import {
  createApiKey,
  createUser,
  deleteApiKey,
  deleteBatchUpload,
  deleteUser,
  getAdminSettings,
  listAuditLogs,
  listApiKeys,
  listBatchUploads,
  listUsers,
  updateAdminSettings,
  updateUser,
} from '../lib/backend'
import type { BackendUser } from '../lib/backend'
import { useStore } from '../store'

export default function AdminPanel({ user }: { user: BackendUser | null }) {
  const [users, setUsers] = useState<any[]>([])
  const [keys, setKeys] = useState<any[]>([])
  const [logs, setLogs] = useState<any[]>([])
  const [uploads, setUploads] = useState<any[]>([])
  const [logPage, setLogPage] = useState({ page: 1, totalPages: 1, total: 0 })
  const [uploadPage, setUploadPage] = useState({ page: 1, totalPages: 1, total: 0 })
  const [settings, setSettings] = useState<any>(null)
  const [newUser, setNewUser] = useState({ username: '', displayName: '', password: '' })
  const [editingUsers, setEditingUsers] = useState<Record<string, { displayName: string; password: string }>>({})
  const [newKey, setNewKey] = useState('')
  const [error, setError] = useState('')
  const [createdToken, setCreatedToken] = useState('')

  const refresh = async () => {
    if (user?.role !== 'admin') return
    const [userRes, settingsRes, keysRes, logRes, uploadRes] = await Promise.all([
      listUsers(),
      getAdminSettings(),
      listApiKeys(),
      listAuditLogs({ page: logPage.page, pageSize: 30 }),
      listBatchUploads({ page: uploadPage.page, pageSize: 20 }),
    ])
    setUsers(userRes.users)
    setSettings(settingsRes.settings)
    useStore.getState().setSettings({
      adminServerImagePath: settingsRes.settings?.serverImagePath || '',
      backendCodexCli: Boolean(settingsRes.settings?.activeProfile?.codexCli),
    })
    setKeys(keysRes.keys)
    setLogs(logRes.logs)
    setUploads(uploadRes.uploads)
    setLogPage({ page: logRes.page, totalPages: logRes.totalPages, total: logRes.total })
    setUploadPage({ page: uploadRes.page, totalPages: uploadRes.totalPages, total: uploadRes.total })
    setEditingUsers((prev) => {
      const next = { ...prev }
      for (const item of userRes.users) {
        if (!next[item.username]) next[item.username] = { displayName: item.displayName || item.username, password: '' }
      }
      return next
    })
  }

  useEffect(() => {
    refresh().catch((err) => setError(err instanceof Error ? err.message : String(err)))
  }, [user?.role, logPage.page, uploadPage.page])

  if (user?.role !== 'admin') return null

  const saveSettings = async () => {
    setError('')
    try {
      const res = await updateAdminSettings(settings)
      setSettings(res.settings)
      useStore.getState().setSettings({
        adminServerImagePath: res.settings?.serverImagePath || '',
        backendCodexCli: Boolean(res.settings?.activeProfile?.codexCli),
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <div className="space-y-4">
      {error && <div className="mb-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-500 dark:bg-red-500/10">{error}</div>}

      <section className="grid gap-4">
        <div className="rounded-xl border border-gray-200/70 p-4 dark:border-white/[0.08]">
          <h3 className="mb-3 text-sm font-bold">用户</h3>
          <div className="mb-3 grid grid-cols-1 gap-2 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_2.5rem]">
            <input value={newUser.username} onChange={(e) => setNewUser({ ...newUser, username: e.target.value })} placeholder="用户名" className="min-w-0 rounded-lg border px-3 py-2 text-sm dark:border-white/[0.08] dark:bg-white/[0.03]" />
            <input value={newUser.displayName} onChange={(e) => setNewUser({ ...newUser, displayName: e.target.value })} placeholder="显示名" className="min-w-0 rounded-lg border px-3 py-2 text-sm dark:border-white/[0.08] dark:bg-white/[0.03]" />
            <input value={newUser.password} onChange={(e) => setNewUser({ ...newUser, password: e.target.value })} placeholder="密码" className="min-w-0 rounded-lg border px-3 py-2 text-sm dark:border-white/[0.08] dark:bg-white/[0.03]" />
            <button
              onClick={async () => {
                await createUser({ username: newUser.username, displayName: newUser.displayName || newUser.username, password: newUser.password || '123456' })
                setNewUser({ username: '', displayName: '', password: '' })
                await refresh()
              }}
              className="inline-flex h-10 w-10 items-center justify-center rounded-lg bg-blue-500 text-white"
              title="新增用户"
              aria-label="新增用户"
            >
              <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 5v14m7-7H5" />
              </svg>
            </button>
          </div>
          <div className="space-y-2">
            {users.map((item) => (
              <div key={item.username} className="grid min-w-0 grid-cols-1 gap-2 rounded-lg bg-gray-50 px-3 py-2 text-sm dark:bg-white/[0.03] lg:grid-cols-[8rem_minmax(0,1fr)_minmax(0,1fr)_auto]">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="min-w-0 truncate font-medium">{item.username}</span>
                  <span className="shrink-0 text-xs text-gray-400">{item.disabled ? '已禁用' : '正常'}</span>
                </div>
                <input
                  value={editingUsers[item.username]?.displayName ?? item.displayName ?? item.username}
                  onChange={(e) => setEditingUsers((prev) => ({ ...prev, [item.username]: { displayName: e.target.value, password: prev[item.username]?.password || '' } }))}
                  placeholder="显示名"
                  className="min-w-0 rounded-md border px-2 py-1.5 text-xs dark:border-white/[0.08] dark:bg-white/[0.03]"
                />
                <input
                  value={editingUsers[item.username]?.password || ''}
                  onChange={(e) => setEditingUsers((prev) => ({ ...prev, [item.username]: { displayName: prev[item.username]?.displayName ?? item.displayName ?? item.username, password: e.target.value } }))}
                  placeholder="新密码（留空不改）"
                  className="min-w-0 rounded-md border px-2 py-1.5 text-xs dark:border-white/[0.08] dark:bg-white/[0.03]"
                />
                <div className="flex items-center justify-end gap-1">
                  <button onClick={async () => {
                    const draft = editingUsers[item.username] || { displayName: item.displayName, password: '' }
                    await updateUser(item.username, { displayName: draft.displayName, ...(draft.password ? { password: draft.password } : {}) })
                    setEditingUsers((prev) => ({ ...prev, [item.username]: { displayName: draft.displayName, password: '' } }))
                    await refresh()
                  }} className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md hover:bg-gray-200 dark:hover:bg-white/[0.08]" title="保存用户" aria-label="保存用户">
                    <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                    </svg>
                  </button>
                  <button onClick={async () => { await updateUser(item.username, { disabled: !item.disabled }); await refresh() }} className="ml-auto inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md hover:bg-gray-200 dark:hover:bg-white/[0.08]" title={item.disabled ? '启用' : '禁用'} aria-label={item.disabled ? '启用' : '禁用'}>
                    <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      {item.disabled ? <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4M12 3a9 9 0 100 18 9 9 0 000-18z" /> : <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M18.364 18.364A9 9 0 015.636 5.636m12.728 12.728A9 9 0 005.636 5.636m12.728 12.728L5.636 5.636" />}
                    </svg>
                  </button>
                  <button onClick={async () => { await deleteUser(item.username); await refresh() }} className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-red-500 hover:bg-red-50 dark:hover:bg-red-500/10" title="删除用户" aria-label="删除用户">
                    <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6M9 7V4h6v3m-8 0h10" />
                    </svg>
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>


      </section>

      <section className="mt-4 rounded-xl border border-gray-200/70 p-4 dark:border-white/[0.08]">
          <h3 className="mb-3 text-sm font-bold">上游服务商</h3>
          {settings && (
            <div className="space-y-3">
              <label className="block text-xs text-gray-500">总体并发数</label>
              <input type="number" min={1} max={20} value={settings.concurrency} onChange={(e) => setSettings({ ...settings, concurrency: Number(e.target.value) })} className="w-full rounded-lg border px-3 py-2 text-sm dark:border-white/[0.08] dark:bg-white/[0.03]" />
              <label className="block text-xs text-gray-500">服务器图片目录</label>
              <input value={settings.serverImagePath || ''} onChange={(e) => setSettings({ ...settings, serverImagePath: e.target.value })} className="w-full rounded-lg border px-3 py-2 text-sm dark:border-white/[0.08] dark:bg-white/[0.03]" />
              <label className="block text-xs text-gray-500">服务商类型</label>
              <select value={settings.activeProfile.provider || 'openai'} onChange={(e) => setSettings({ ...settings, activeProfile: { ...settings.activeProfile, provider: e.target.value } })} className="w-full rounded-lg border px-3 py-2 text-sm dark:border-white/[0.08] dark:bg-white/[0.03]">
                <option value="openai">OpenAI 兼容接口</option>
                <option value="fal">fal.ai</option>
              </select>
              <label className="block text-xs text-gray-500">上游服务商 Base URL</label>
              <input value={settings.activeProfile.baseUrl || ''} onChange={(e) => setSettings({ ...settings, activeProfile: { ...settings.activeProfile, baseUrl: e.target.value } })} className="w-full rounded-lg border px-3 py-2 text-sm dark:border-white/[0.08] dark:bg-white/[0.03]" />
              <label className="block text-xs text-gray-500">上游服务商密钥</label>
              <input value={settings.activeProfile.apiKey || ''} type="password" onChange={(e) => setSettings({ ...settings, activeProfile: { ...settings.activeProfile, apiKey: e.target.value } })} className="w-full rounded-lg border px-3 py-2 text-sm dark:border-white/[0.08] dark:bg-white/[0.03]" />
              <label className="block text-xs text-gray-500">模型</label>
              <input value={settings.activeProfile.model || ''} onChange={(e) => setSettings({ ...settings, activeProfile: { ...settings.activeProfile, model: e.target.value } })} className="w-full rounded-lg border px-3 py-2 text-sm dark:border-white/[0.08] dark:bg-white/[0.03]" />
              <label className="block text-xs text-gray-500">请求模式</label>
              <select value={settings.activeProfile.apiMode || 'images'} onChange={(e) => setSettings({ ...settings, activeProfile: { ...settings.activeProfile, apiMode: e.target.value } })} className="w-full rounded-lg border px-3 py-2 text-sm dark:border-white/[0.08] dark:bg-white/[0.03]">
                <option value="images">Images API (v1/images/generations)</option>
                <option value="responses">Responses API (v1/responses)</option>
              </select>
              <label className="block text-xs text-gray-500">超时时间 (秒)</label>
              <input type="number" value={settings.activeProfile.timeout || 300} onChange={(e) => setSettings({ ...settings, activeProfile: { ...settings.activeProfile, timeout: Number(e.target.value) } })} className="w-full rounded-lg border px-3 py-2 text-sm dark:border-white/[0.08] dark:bg-white/[0.03]" />
              {settings.activeProfile.provider === 'openai' && (
                <div className="space-y-2 rounded-lg bg-gray-50 p-3 dark:bg-white/[0.02]">
                  <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
                    <input type="checkbox" checked={!!settings.activeProfile.codexCli} onChange={(e) => setSettings({ ...settings, activeProfile: { ...settings.activeProfile, codexCli: e.target.checked } })} className="rounded border-gray-300 dark:border-white/[0.1] dark:bg-white/[0.03]" />
                    Codex CLI 兼容模式
                  </label>
                  <p className="text-xs text-gray-500 dark:text-gray-400">开启后跳过 quality 参数、添加 prompt 改写保护前缀，并在 N&gt;1 时拆分为多个单图请求。</p>
                  <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
                    <input type="checkbox" checked={!!settings.activeProfile.responseFormatB64Json} onChange={(e) => setSettings({ ...settings, activeProfile: { ...settings.activeProfile, responseFormatB64Json: e.target.checked } })} className="rounded border-gray-300 dark:border-white/[0.1] dark:bg-white/[0.03]" />
                    返回 Base64 图片数据
                  </label>
                </div>
              )}
              <button onClick={saveSettings} className="inline-flex h-10 w-10 items-center justify-center rounded-lg bg-blue-500 text-white" title="保存设置" aria-label="保存设置">
                <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
              </button>
            </div>
          )}
      </section>


      <section className="mt-4 rounded-xl border border-gray-200/70 p-4 dark:border-white/[0.08]">
        <h3 className="mb-1 text-sm font-bold">后端访问令牌</h3>
        <p className="mb-3 text-xs text-gray-500 dark:text-gray-400">用于脚本、skill 或第三方系统直接调用本后端。不要和上游服务商密钥混用。</p>
        <div className="mb-3 grid grid-cols-1 gap-2 sm:grid-cols-[minmax(0,1fr)_2.5rem]">
          <input value={newKey} onChange={(e) => setNewKey(e.target.value)} placeholder="令牌名称" className="min-w-0 rounded-lg border px-3 py-2 text-sm dark:border-white/[0.08] dark:bg-white/[0.03]" />
          <button onClick={async () => { const res = await createApiKey({ name: newKey || '后端访问令牌' }); setCreatedToken(res.key.token); setNewKey(''); await refresh() }} className="inline-flex h-10 w-10 items-center justify-center rounded-lg bg-blue-500 text-white" title="新增令牌" aria-label="新增令牌">
            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 5v14m7-7H5" />
            </svg>
          </button>
        </div>
        {createdToken && <div className="mb-3 overflow-auto rounded-lg bg-green-50 px-3 py-2 font-mono text-xs text-green-700 dark:bg-green-500/10 dark:text-green-300">{createdToken}</div>}
        <div className="space-y-2">
          {keys.map((key) => (
            <div key={key.id} className="flex min-w-0 items-center gap-3 rounded-lg bg-gray-50 px-3 py-2 text-sm dark:bg-white/[0.03]">
              <span className="min-w-0 truncate">{key.name}</span>
              <span className="min-w-0 truncate font-mono text-xs text-gray-400">{key.token}</span>
              <button onClick={async () => { await deleteApiKey(key.id); await refresh() }} className="ml-auto inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-red-500 hover:bg-red-50 dark:hover:bg-red-500/10" title="删除令牌" aria-label="删除令牌">
                <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6M9 7V4h6v3m-8 0h10" />
                </svg>
              </button>
            </div>
          ))}
        </div>
      </section>

      <section className="mt-4 rounded-xl border border-gray-200/70 p-4 dark:border-white/[0.08]">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-bold">批量上传原图</h3>
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">仅保存批量上传模式中的本地输入图；删除后不影响已生成结果。</p>
          </div>
          <div className="flex items-center gap-2 text-xs text-gray-500">
            <span>{uploadPage.total} 条</span>
            <button disabled={uploadPage.page <= 1} onClick={() => setUploadPage((v) => ({ ...v, page: Math.max(1, v.page - 1) }))} className="inline-flex h-8 w-8 items-center justify-center rounded border disabled:opacity-40 dark:border-white/[0.08]" title="上一页" aria-label="上一页">
              <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
              </svg>
            </button>
            <button disabled={uploadPage.page >= uploadPage.totalPages} onClick={() => setUploadPage((v) => ({ ...v, page: v.page + 1 }))} className="inline-flex h-8 w-8 items-center justify-center rounded border disabled:opacity-40 dark:border-white/[0.08]" title="下一页" aria-label="下一页">
              <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              </svg>
            </button>
          </div>
        </div>
        <div className="space-y-2">
          {uploads.map((upload) => (
            <div key={upload.id} className="grid min-w-0 grid-cols-1 gap-2 rounded-lg bg-gray-50 px-3 py-2 text-xs dark:bg-white/[0.03] md:grid-cols-[minmax(0,1fr)_8rem_7rem_auto]">
              <div className="min-w-0">
                <div className="truncate font-medium">{upload.fileName}</div>
                <div className="truncate text-gray-400">{upload.username} / {upload.jobId}</div>
              </div>
              <span className="text-gray-500">{new Date(upload.createdAt).toLocaleString()}</span>
              <span className="text-gray-500">{upload.size ? `${Math.round(upload.size / 1024)} KB` : '-'}</span>
              <button onClick={async () => { await deleteBatchUpload(upload.id); await refresh() }} className="inline-flex h-8 w-8 items-center justify-center rounded-md text-red-500 hover:bg-red-50 dark:hover:bg-red-500/10" title="删除原图" aria-label="删除原图">
                <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6M9 7V4h6v3m-8 0h10" />
                </svg>
              </button>
            </div>
          ))}
          {uploads.length === 0 && <div className="text-sm text-gray-400">暂无批量上传原图</div>}
        </div>
      </section>

      <section className="mt-4 rounded-xl border border-gray-200/70 p-4 dark:border-white/[0.08]">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h3 className="text-sm font-bold">审计日志</h3>
          <div className="flex items-center gap-2 text-xs text-gray-500">
            <span>{logPage.total} 条</span>
            <button disabled={logPage.page <= 1} onClick={() => setLogPage((v) => ({ ...v, page: Math.max(1, v.page - 1) }))} className="inline-flex h-8 w-8 items-center justify-center rounded border disabled:opacity-40 dark:border-white/[0.08]" title="上一页" aria-label="上一页">
              <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
              </svg>
            </button>
            <button disabled={logPage.page >= logPage.totalPages} onClick={() => setLogPage((v) => ({ ...v, page: v.page + 1 }))} className="inline-flex h-8 w-8 items-center justify-center rounded border disabled:opacity-40 dark:border-white/[0.08]" title="下一页" aria-label="下一页">
              <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              </svg>
            </button>
          </div>
        </div>
        <div className="space-y-2">
          {logs.map((log) => (
            <div key={log.id} className="rounded-lg bg-gray-50 px-3 py-2 text-xs dark:bg-white/[0.03]">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-gray-400">{new Date(log.at).toLocaleString()}</span>
                <span className="font-medium">{log.username}</span>
                <span className="rounded bg-blue-50 px-1.5 py-0.5 text-blue-600 dark:bg-blue-500/10 dark:text-blue-300">{log.action}</span>
              </div>
              {log.details && <pre className="mt-1 max-h-24 overflow-auto text-gray-500">{JSON.stringify(log.details, null, 2)}</pre>}
            </div>
          ))}
          {logs.length === 0 && <div className="text-sm text-gray-400">暂无审计日志</div>}
        </div>
      </section>
    </div>
  )
}
