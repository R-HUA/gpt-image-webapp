import type { AppSettings, TaskParams } from '../types'

export interface BackendUser {
  username: string
  role: 'admin' | 'user'
}

export interface BackendJob {
  id: string
  status: 'queued' | 'running' | 'done' | 'error' | 'cancelled'
  queuePosition: number
  createdAt: number
  startedAt: number | null
  finishedAt: number | null
  error: string | null
  result?: BackendJobResult | null
}

export interface BackendJobResult {
  images: string[]
  actualParams?: Partial<TaskParams>
  actualParamsList?: Array<Partial<TaskParams> | undefined>
  revisedPrompts?: Array<string | undefined>
  rawImageUrls?: string[]
  records?: Array<{ id: string; outputUrl: string; thumbnailUrl: string }>
}

export interface BackendGalleryRecord {
  id: string
  jobId: string
  username: string
  prompt: string
  params: TaskParams
  apiProvider?: string
  apiModel?: string
  outputUrl: string
  thumbnailUrl: string
  mime?: string
  createdAt: number
  deleted?: boolean
  deletedAt?: number
  actualParams?: Partial<TaskParams>
  revisedPrompt?: string
  rawImageUrl?: string
}

export interface BackendPage<T> {
  page: number
  pageSize: number
  total: number
  totalPages: number
  [key: string]: T[] | number
}

export interface AuditLogRecord {
  id: string
  at: number
  username: string
  role: string
  action: string
  ip?: string
  userAgent?: string
  details?: Record<string, unknown>
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    credentials: 'include',
    cache: 'no-store',
    ...init,
    headers: {
      ...(init?.body && !(init.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
      ...init?.headers,
    },
  })
  const payload = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(payload.error || `HTTP ${res.status}`)
  return payload as T
}

export function getSession() {
  return api<{ user: BackendUser | null }>('/api/session')
}

export function login(username: string, password: string) {
  return api<{ user: BackendUser }>('/api/login', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  })
}

export function logout() {
  return api<{ ok: true }>('/api/logout', { method: 'POST' })
}

export function createBackendJob(request: {
  settings: AppSettings
  prompt: string
  params: TaskParams
  inputImageDataUrls: string[]
  maskDataUrl?: string
  batch?: boolean
  batchCount?: number
  serverImagePath?: string
}) {
  return api<{ job: BackendJob }>('/api/jobs', {
    method: 'POST',
    body: JSON.stringify(request),
  })
}

export function getBackendJob(id: string) {
  return api<{ job: BackendJob }>(`/api/jobs/${encodeURIComponent(id)}`)
}

export function cancelBackendJob(id: string) {
  return api<{ job: BackendJob }>(`/api/jobs/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

export function listGallery(params?: { mode?: 'all'; owner?: string; page?: number; pageSize?: number }) {
  const query = new URLSearchParams()
  if (params?.mode) query.set('mode', params.mode)
  if (params?.owner) query.set('owner', params.owner)
  if (params?.page) query.set('page', String(params.page))
  if (params?.pageSize) query.set('pageSize', String(params.pageSize))
  return api<{ results: BackendGalleryRecord[]; page: number; pageSize: number; total: number; totalPages: number }>(`/api/gallery${query.size ? `?${query}` : ''}`)
}

export function deleteGalleryResult(id: string) {
  return api<{ record: BackendGalleryRecord }>(`/api/gallery/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

export function listUsers() {
  return api<{ users: Array<{ username: string; displayName: string; disabled: boolean; createdAt: number; updatedAt?: number }> }>('/api/admin/users')
}

export function createUser(input: { username: string; displayName?: string; password: string; disabled?: boolean }) {
  return api('/api/admin/users', { method: 'POST', body: JSON.stringify(input) })
}

export function updateUser(username: string, input: { displayName?: string; password?: string; disabled?: boolean }) {
  return api(`/api/admin/users/${encodeURIComponent(username)}`, { method: 'PATCH', body: JSON.stringify(input) })
}

export function deleteUser(username: string) {
  return api(`/api/admin/users/${encodeURIComponent(username)}`, { method: 'DELETE' })
}

export function getAdminSettings() {
  return api<{ settings: any }>('/api/admin/settings')
}

export function updateAdminSettings(settings: any) {
  return api<{ settings: any }>('/api/admin/settings', { method: 'PATCH', body: JSON.stringify(settings) })
}

export function listApiKeys() {
  return api<{ keys: Array<{ id: string; name: string; token: string; username: string; role: string; createdAt: number }> }>('/api/admin/api-keys')
}

export function createApiKey(input: { name: string; username?: string; role?: 'admin' | 'user' }) {
  return api<{ key: { id: string; name: string; token: string; username: string; role: string; createdAt: number } }>('/api/admin/api-keys', {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

export function deleteApiKey(id: string) {
  return api(`/api/admin/api-keys/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

export function listAuditLogs(params?: { page?: number; pageSize?: number }) {
  const query = new URLSearchParams()
  if (params?.page) query.set('page', String(params.page))
  if (params?.pageSize) query.set('pageSize', String(params.pageSize))
  return api<{ logs: AuditLogRecord[]; page: number; pageSize: number; total: number; totalPages: number }>(`/api/admin/audit-logs${query.size ? `?${query}` : ''}`)
}

export interface BackendBatchUploadRecord {
  id: string
  jobId: string
  username: string
  inputIndex: number
  fileName: string
  mime?: string
  size?: number
  createdAt: number
  deleted?: boolean
  deletedAt?: number
}

export function listBatchUploads(params?: { owner?: string; page?: number; pageSize?: number }) {
  const query = new URLSearchParams()
  if (params?.owner) query.set('owner', params.owner)
  if (params?.page) query.set('page', String(params.page))
  if (params?.pageSize) query.set('pageSize', String(params.pageSize))
  return api<{ uploads: BackendBatchUploadRecord[]; page: number; pageSize: number; total: number; totalPages: number }>(`/api/admin/batch-uploads${query.size ? `?${query}` : ''}`)
}

export function deleteBatchUpload(id: string) {
  return api<{ upload: BackendBatchUploadRecord }>(`/api/admin/batch-uploads/${encodeURIComponent(id)}`, { method: 'DELETE' })
}
