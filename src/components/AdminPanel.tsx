import { useEffect, useState } from 'react'
import {
  createApiKey,
  createUser,
  deleteApiKey,
  deleteUser,
  getAdminSettings,
  listAuditLogs,
  listApiKeys,
  listUsers,
  updateAdminSettings,
  updateUser,
} from '../lib/backend'
import type { BackendUser } from '../lib/backend'

export default function AdminPanel({ user, onClose }: { user: BackendUser | null; onClose: () => void }) {
  const [users, setUsers] = useState<any[]>([])
  const [keys, setKeys] = useState<any[]>([])
  const [logs, setLogs] = useState<any[]>([])
  const [logPage, setLogPage] = useState({ page: 1, totalPages: 1, total: 0 })
  const [settings, setSettings] = useState<any>(null)
  const [newUser, setNewUser] = useState({ username: '', password: '' })
  const [newKey, setNewKey] = useState('')
  const [error, setError] = useState('')
  const [createdToken, setCreatedToken] = useState('')

  const refresh = async () => {
    if (user?.role !== 'admin') return
    const [userRes, settingsRes, keysRes, logRes] = await Promise.all([listUsers(), getAdminSettings(), listApiKeys(), listAuditLogs({ page: logPage.page, pageSize: 30 })])
    setUsers(userRes.users)
    setSettings(settingsRes.settings)
    setKeys(keysRes.keys)
    setLogs(logRes.logs)
    setLogPage({ page: logRes.page, totalPages: logRes.totalPages, total: logRes.total })
  }

  useEffect(() => {
    refresh().catch((err) => setError(err instanceof Error ? err.message : String(err)))
  }, [user?.role, logPage.page])

  if (user?.role !== 'admin') return null

  const saveSettings = async () => {
    setError('')
    try {
      const res = await updateAdminSettings(settings)
      setSettings(res.settings)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/30 backdrop-blur-sm" onClick={onClose} />
      <div className="relative z-10 h-[86vh] w-full max-w-5xl overflow-hidden rounded-2xl border border-white/50 bg-white/95 shadow-2xl dark:border-white/[0.08] dark:bg-gray-900/95">
        <div className="flex items-center justify-between border-b border-gray-200/70 px-5 py-4 dark:border-white/[0.08]">
          <h2 className="text-base font-bold text-gray-800 dark:text-gray-100">后台管理</h2>
          <button onClick={onClose} className="rounded-lg px-3 py-1.5 text-sm text-gray-500 hover:bg-gray-100 dark:hover:bg-white/[0.06]">关闭</button>
        </div>
        <div className="h-[calc(86vh-57px)] overflow-y-auto p-5">
          {error && <div className="mb-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-500 dark:bg-red-500/10">{error}</div>}

          <section className="grid gap-4 md:grid-cols-2">
            <div className="rounded-xl border border-gray-200/70 p-4 dark:border-white/[0.08]">
              <h3 className="mb-3 text-sm font-bold">用户</h3>
              <div className="mb-3 grid grid-cols-[1fr_1fr_auto] gap-2">
                <input value={newUser.username} onChange={(e) => setNewUser({ ...newUser, username: e.target.value })} placeholder="用户名" className="rounded-lg border px-3 py-2 text-sm dark:border-white/[0.08] dark:bg-white/[0.03]" />
                <input value={newUser.password} onChange={(e) => setNewUser({ ...newUser, password: e.target.value })} placeholder="密码" className="rounded-lg border px-3 py-2 text-sm dark:border-white/[0.08] dark:bg-white/[0.03]" />
                <button
                  onClick={async () => {
                    await createUser({ username: newUser.username, password: newUser.password || '123456' })
                    setNewUser({ username: '', password: '' })
                    await refresh()
                  }}
                  className="rounded-lg bg-blue-500 px-3 py-2 text-sm text-white"
                >
                  新增
                </button>
              </div>
              <div className="space-y-2">
                {users.map((item) => (
                  <div key={item.username} className="flex items-center gap-2 rounded-lg bg-gray-50 px-3 py-2 text-sm dark:bg-white/[0.03]">
                    <span className="font-medium">{item.username}</span>
                    <span className="text-xs text-gray-400">{item.disabled ? '已禁用' : '正常'}</span>
                    <button onClick={async () => { await updateUser(item.username, { disabled: !item.disabled }); await refresh() }} className="ml-auto rounded-md px-2 py-1 text-xs hover:bg-gray-200 dark:hover:bg-white/[0.08]">{item.disabled ? '启用' : '禁用'}</button>
                    <button onClick={async () => { await deleteUser(item.username); await refresh() }} className="rounded-md px-2 py-1 text-xs text-red-500 hover:bg-red-50 dark:hover:bg-red-500/10">删除</button>
                  </div>
                ))}
              </div>
            </div>

            <div className="rounded-xl border border-gray-200/70 p-4 dark:border-white/[0.08]">
              <h3 className="mb-3 text-sm font-bold">请求与服务商</h3>
              {settings && (
                <div className="space-y-3">
                  <label className="block text-xs text-gray-500">总体并发数</label>
                  <input type="number" min={1} max={20} value={settings.concurrency} onChange={(e) => setSettings({ ...settings, concurrency: Number(e.target.value) })} className="w-full rounded-lg border px-3 py-2 text-sm dark:border-white/[0.08] dark:bg-white/[0.03]" />
                  <label className="block text-xs text-gray-500">服务器图片目录</label>
                  <input value={settings.serverImagePath || ''} onChange={(e) => setSettings({ ...settings, serverImagePath: e.target.value })} className="w-full rounded-lg border px-3 py-2 text-sm dark:border-white/[0.08] dark:bg-white/[0.03]" />
                  <label className="block text-xs text-gray-500">API Base URL</label>
                  <input value={settings.activeProfile.baseUrl || ''} onChange={(e) => setSettings({ ...settings, activeProfile: { ...settings.activeProfile, baseUrl: e.target.value } })} className="w-full rounded-lg border px-3 py-2 text-sm dark:border-white/[0.08] dark:bg-white/[0.03]" />
                  <label className="block text-xs text-gray-500">API Key</label>
                  <input value={settings.activeProfile.apiKey || ''} onChange={(e) => setSettings({ ...settings, activeProfile: { ...settings.activeProfile, apiKey: e.target.value } })} className="w-full rounded-lg border px-3 py-2 text-sm dark:border-white/[0.08] dark:bg-white/[0.03]" />
                  <label className="block text-xs text-gray-500">模型</label>
                  <input value={settings.activeProfile.model || ''} onChange={(e) => setSettings({ ...settings, activeProfile: { ...settings.activeProfile, model: e.target.value } })} className="w-full rounded-lg border px-3 py-2 text-sm dark:border-white/[0.08] dark:bg-white/[0.03]" />
                  <button onClick={saveSettings} className="rounded-lg bg-blue-500 px-4 py-2 text-sm text-white">保存设置</button>
                </div>
              )}
            </div>
          </section>

          <section className="mt-4 rounded-xl border border-gray-200/70 p-4 dark:border-white/[0.08]">
            <h3 className="mb-3 text-sm font-bold">后端 API Key</h3>
            <div className="mb-3 flex gap-2">
              <input value={newKey} onChange={(e) => setNewKey(e.target.value)} placeholder="名称" className="flex-1 rounded-lg border px-3 py-2 text-sm dark:border-white/[0.08] dark:bg-white/[0.03]" />
              <button onClick={async () => { const res = await createApiKey({ name: newKey || 'API Key' }); setCreatedToken(res.key.token); setNewKey(''); await refresh() }} className="rounded-lg bg-blue-500 px-3 py-2 text-sm text-white">新增 Key</button>
            </div>
            {createdToken && <div className="mb-3 rounded-lg bg-green-50 px-3 py-2 font-mono text-xs text-green-700 dark:bg-green-500/10 dark:text-green-300">{createdToken}</div>}
            <div className="space-y-2">
              {keys.map((key) => (
                <div key={key.id} className="flex items-center gap-3 rounded-lg bg-gray-50 px-3 py-2 text-sm dark:bg-white/[0.03]">
                  <span>{key.name}</span>
                  <span className="font-mono text-xs text-gray-400">{key.token}</span>
                  <button onClick={async () => { await deleteApiKey(key.id); await refresh() }} className="ml-auto rounded-md px-2 py-1 text-xs text-red-500 hover:bg-red-50 dark:hover:bg-red-500/10">删除</button>
                </div>
              ))}
            </div>
          </section>

          <section className="mt-4 rounded-xl border border-gray-200/70 p-4 dark:border-white/[0.08]">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-sm font-bold">审计日志</h3>
              <div className="flex items-center gap-2 text-xs text-gray-500">
                <span>{logPage.total} 条</span>
                <button disabled={logPage.page <= 1} onClick={() => setLogPage((v) => ({ ...v, page: Math.max(1, v.page - 1) }))} className="rounded border px-2 py-1 disabled:opacity-40 dark:border-white/[0.08]">上一页</button>
                <button disabled={logPage.page >= logPage.totalPages} onClick={() => setLogPage((v) => ({ ...v, page: v.page + 1 }))} className="rounded border px-2 py-1 disabled:opacity-40 dark:border-white/[0.08]">下一页</button>
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
      </div>
    </div>
  )
}
