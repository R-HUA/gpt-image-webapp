import { useState } from 'react'
import { login } from '../lib/backend'

export default function LoginScreen({ onLogin }: { onLogin: () => void }) {
  const [username, setUsername] = useState('admin')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setError('')
    try {
      await login(username, password)
      onLogin()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  return (
    <main className="min-h-screen bg-gray-50 text-gray-900 dark:bg-gray-950 dark:text-gray-100 flex items-center justify-center px-4">
      <form onSubmit={submit} className="w-full max-w-sm rounded-2xl border border-gray-200/70 bg-white/90 p-6 shadow-xl ring-1 ring-black/5 dark:border-white/[0.08] dark:bg-gray-900/90 dark:ring-white/10">
        <h1 className="text-lg font-bold">GPT Image Playground</h1>
        <div className="mt-6 space-y-4">
          <label className="block">
            <span className="mb-1 block text-xs text-gray-500 dark:text-gray-400">用户名</span>
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="w-full rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm outline-none focus:border-blue-400 dark:border-white/[0.08] dark:bg-white/[0.03]"
              autoComplete="username"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs text-gray-500 dark:text-gray-400">密码</span>
            <input
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              type="password"
              className="w-full rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm outline-none focus:border-blue-400 dark:border-white/[0.08] dark:bg-white/[0.03]"
              autoComplete="current-password"
            />
          </label>
        </div>
        {error && <div className="mt-4 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-500 dark:bg-red-500/10 dark:text-red-300">{error}</div>}
        <button
          type="submit"
          disabled={loading || !username.trim() || !password}
          className="mt-5 w-full rounded-xl bg-blue-500 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-blue-600 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {loading ? '登录中...' : '登录'}
        </button>
      </form>
    </main>
  )
}
