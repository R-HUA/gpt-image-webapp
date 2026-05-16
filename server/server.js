import http from 'node:http'
import crypto from 'node:crypto'
import path from 'node:path'
import { promises as fs } from 'node:fs'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import { serverConfig } from './config.js'
import { JsonStore } from './store.js'
import { callImageProvider, dataUrlToBuffer, bufferToDataUrl } from './imageApi.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, '..')
const distDir = path.join(rootDir, 'dist')
const store = new JsonStore(path.resolve(rootDir, serverConfig.dataDir, 'db.json'))
const sessions = new Map()
const jobs = new Map()
const queue = []
let activeCount = 0

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp'])
const PAGE_SIZE_MAX = 100
const LOG_COMPONENT = 'gpt-image-backend'

function formatLogValue(value) {
  if (value == null) return ''
  if (typeof value === 'string') {
    const text = value.replace(/\s+/g, ' ').trim()
    return /[\s="]/.test(text) ? `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : text
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return `"${JSON.stringify(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

function log(level, event, details = {}) {
  const timestamp = new Date().toISOString().replace('T', ' ').replace('Z', '')
  const normalizedLevel = String(level || 'info').toUpperCase().padEnd(5)
  const pairs = Object.entries(details)
    .filter(([, value]) => value !== undefined && value !== '')
    .map(([key, value]) => `${key}=${formatLogValue(value)}`)
    .join(' ')
  const line = `${timestamp} ${normalizedLevel} [${LOG_COMPONENT}] ${event}${pairs ? ` - ${pairs}` : ''}`
  if (level === 'error') console.error(line)
  else console.log(line)
}

function logError(event, err, details = {}) {
  log('error', event, {
    ...details,
    errorName: err?.name,
    errorMessage: err instanceof Error ? err.message : String(err),
    upstreamStatus: err?.upstream?.status,
    upstreamEndpoint: err?.upstream?.endpoint,
    upstreamModel: err?.upstream?.model,
    upstreamRequestType: err?.upstream?.requestType,
    upstreamInputImageCount: err?.upstream?.inputImageCount,
    upstreamHasMask: err?.upstream?.hasMask,
    upstreamErrorType: err?.upstream?.errorType,
    upstreamErrorCode: err?.upstream?.errorCode,
    upstreamErrorParam: err?.upstream?.errorParam,
    upstreamBodyPreview: err?.upstream?.bodyPreview,
    errorStack: err?.stack,
  })
}

function requestLogDetails(req, user = null) {
  return {
    method: req.method,
    path: req.url?.split('?')[0],
    username: user?.username,
    role: user?.role,
    ip: req.socket?.remoteAddress,
  }
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex')
  return `${salt}:${hash}`
}

function verifyPassword(password, stored) {
  const [salt, hash] = String(stored || '').split(':')
  if (!salt || !hash) return false
  const candidate = crypto.scryptSync(password, salt, 64)
  return crypto.timingSafeEqual(candidate, Buffer.from(hash, 'hex'))
}

function id(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(6).toString('hex')}`
}

function safeSegment(value) {
  return String(value || 'unknown').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80) || 'unknown'
}

function pad(value) {
  return String(value).padStart(2, '0')
}

function dateStamp(date = new Date()) {
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}_${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}_${date.getMilliseconds()}`
}

async function ensureDirs() {
  await fs.mkdir(path.resolve(rootDir, serverConfig.outputDir), { recursive: true })
  await fs.mkdir(path.resolve(rootDir, serverConfig.thumbnailDir), { recursive: true })
  await fs.mkdir(path.resolve(rootDir, serverConfig.batchUploadDir), { recursive: true })
}

function getCookie(req, name) {
  const cookie = req.headers.cookie || ''
  for (const part of cookie.split(';')) {
    const [key, ...rest] = part.trim().split('=')
    if (key === name) return decodeURIComponent(rest.join('='))
  }
  return ''
}

function send(res, status, body, headers = {}) {
  const payload = body == null ? '' : typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': Buffer.isBuffer(payload) ? 'application/octet-stream' : 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  })
  res.end(payload)
}

function sendJson(res, body, status = 200, headers = {}) {
  send(res, status, body, headers)
}

async function addAudit(user, action, details = {}, req = null) {
  store.data.auditLogs.unshift({
    id: id('audit'),
    at: Date.now(),
    username: user?.username || 'anonymous',
    role: user?.role || 'anonymous',
    action,
    ip: req?.socket?.remoteAddress || '',
    userAgent: req?.headers?.['user-agent'] || '',
    details,
  })
  store.data.auditLogs = store.data.auditLogs.slice(0, 5000)
  await store.save()
}

async function readJson(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > 1024 * 1024 * 512) throw new Error('请求体过大')
    chunks.push(chunk)
  }
  if (!chunks.length) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function currentSession(req) {
  const token = getCookie(req, 'gip_session')
  const session = token ? sessions.get(token) : null
  if (!session) return null
  const user = session.role === 'admin'
    ? { username: serverConfig.admin.username, role: 'admin', disabled: false }
    : store.data.users.find((item) => item.username === session.username)
  if (!user || user.disabled) return null
  return { token, username: session.username, role: session.role }
}

function getBearerUser(req) {
  const auth = req.headers.authorization || ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : ''
  if (!token) return null
  const key = store.data.apiKeys.find((item) => item.token === token && !item.disabled)
  if (!key) return null
  return { username: key.username || serverConfig.admin.username, role: key.role || 'admin', apiKeyId: key.id }
}

function requireAuth(req, res) {
  const user = currentSession(req) || getBearerUser(req)
  if (!user) {
    sendJson(res, { error: '未登录' }, 401)
    return null
  }
  return user
}

function requireAdmin(req, res) {
  const user = requireAuth(req, res)
  if (!user) return null
  if (user.role !== 'admin') {
    sendJson(res, { error: '需要管理员权限' }, 403)
    return null
  }
  return user
}

async function bootstrapAdmin() {
  if (!store.data.adminPasswordHash) {
    store.data.adminPasswordHash = hashPassword(serverConfig.admin.password, 'admin-fixed-salt')
    await store.save()
    log('info', 'admin.bootstrap_password.initialized', { username: serverConfig.admin.username })
  }
}

function publicUser(user) {
  return {
    username: user.username,
    displayName: user.displayName || user.username,
    disabled: Boolean(user.disabled),
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  }
}

function getJobView(job) {
  return {
    id: job.id,
    status: job.status,
    queuePosition: job.status === 'queued' ? queue.findIndex((item) => item.id === job.id) + 1 : 0,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    error: job.error,
    result: job.result,
  }
}

async function saveDataUrl(dataUrl, dir, basename) {
  const { buffer, ext, mime } = dataUrlToBuffer(dataUrl)
  await fs.mkdir(dir, { recursive: true })
  const filePath = path.join(dir, `${basename}.${ext}`)
  await fs.writeFile(filePath, buffer)
  log('info', 'file.saved', { filePath, mime, bytes: buffer.length })
  return { filePath, ext, mime, size: buffer.length }
}

async function makeThumbnail(sourcePath, targetPath) {
  await fs.mkdir(path.dirname(targetPath), { recursive: true })
  const webpPath = targetPath.replace(/\.[^.]+$/, '.webp')
  await sharp(sourcePath)
    .rotate()
    .resize({ width: 512, height: 512, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 78, effort: 4 })
    .toFile(webpPath)
  log('info', 'thumbnail.created', { sourcePath, thumbnailPath: webpPath })
  return webpPath
}

async function persistBatchUploads(job, inputImages) {
  const saved = []
  if (!Array.isArray(inputImages) || !inputImages.length) return saved
  const dir = path.resolve(rootDir, serverConfig.batchUploadDir, safeSegment(job.username))
  for (let i = 0; i < inputImages.length; i++) {
    const basename = `${dateStamp()}_${job.id}_input_${i + 1}`
    const savedFile = await saveDataUrl(inputImages[i], dir, basename)
    const record = {
      id: id('upload'),
      jobId: job.id,
      username: job.username,
      inputIndex: i + 1,
      filePath: savedFile.filePath,
      mime: savedFile.mime,
      size: savedFile.size,
      createdAt: Date.now(),
      deleted: false,
    }
    store.data.batchUploads.unshift(record)
    saved.push(record)
  }
  await store.save()
  log('info', 'job.batch_uploads.persisted', { jobId: job.id, username: job.username, count: saved.length, dir })
  return saved
}

async function listServerImages(dir) {
  const resolved = path.resolve(dir)
  const items = await fs.readdir(resolved, { withFileTypes: true })
  return items
    .filter((item) => item.isFile() && IMAGE_EXTS.has(path.extname(item.name).toLowerCase()))
    .map((item) => path.join(resolved, item.name))
}

async function readImageFileAsDataUrl(filePath) {
  const ext = path.extname(filePath).toLowerCase()
  const mime = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : ext === '.webp' ? 'image/webp' : 'image/png'
  return bufferToDataUrl(await fs.readFile(filePath), mime)
}

function publicBatchUpload(record) {
  return {
    id: record.id,
    jobId: record.jobId,
    username: record.username,
    inputIndex: record.inputIndex,
    fileName: path.basename(record.filePath || ''),
    mime: record.mime,
    size: record.size,
    createdAt: record.createdAt,
    deleted: Boolean(record.deleted),
    deletedAt: record.deletedAt,
  }
}

async function persistResult(job, result) {
  const usernameDir = safeSegment(job.username)
  const outputDir = path.resolve(rootDir, serverConfig.outputDir, usernameDir)
  const thumbDir = path.resolve(rootDir, serverConfig.thumbnailDir, usernameDir)
  const records = []
  for (let i = 0; i < result.images.length; i++) {
    const basename = `${dateStamp()}_${job.id}_${i + 1}`
    const saved = await saveDataUrl(result.images[i], outputDir, basename)
    const thumbPath = await makeThumbnail(saved.filePath, path.join(thumbDir, `${basename}.${saved.ext}`))
    records.push({
      id: id('result'),
      jobId: job.id,
      username: job.username,
      prompt: job.request.prompt,
      params: job.request.params,
      apiProvider: store.data.settings.activeProfile.provider,
      apiModel: store.data.settings.activeProfile.model,
      outputPath: saved.filePath,
      thumbnailPath: thumbPath,
      outputUrl: `/api/files/result/${encodeURIComponent(records.length)}/${encodeURIComponent(path.basename(saved.filePath))}?resultId=`,
      mime: saved.mime,
      createdAt: Date.now(),
      deleted: false,
      actualParams: result.actualParamsList?.[i] || result.actualParams,
      revisedPrompt: result.revisedPrompts?.[i],
      rawImageUrl: result.rawImageUrls?.[i],
    })
  }
  for (const record of records) {
    record.outputUrl = `/api/gallery/${record.id}/image`
    record.thumbnailUrl = `/api/gallery/${record.id}/thumbnail`
    store.data.results.unshift(record)
  }
  await store.save()
  log('info', 'job.results.persisted', { jobId: job.id, username: job.username, count: records.length, outputDir, thumbDir })
  return records
}

function enqueue(job) {
  jobs.set(job.id, job)
  queue.push(job)
  log('info', 'job.queued', {
    jobId: job.id,
    username: job.username,
    queueLength: queue.length,
    promptLength: String(job.request.prompt || '').length,
    inputImageCount: Array.isArray(job.request.inputImageDataUrls) ? job.request.inputImageDataUrls.length : 0,
    batch: Boolean(job.request.batch),
    batchCount: job.request.batchCount,
  })
  pumpQueue()
}

function pumpQueue() {
  const concurrency = Math.max(1, Number(store.data.settings.concurrency || 2))
  while (activeCount < concurrency && queue.length) {
    const job = queue.shift()
    if (!job || job.status !== 'queued') continue
    activeCount++
    log('info', 'job.dequeued', {
      jobId: job.id,
      username: job.username,
      activeCount,
      concurrency,
      remainingQueue: queue.length,
    })
    runJob(job).finally(() => {
      activeCount--
      log('info', 'job.worker.released', { jobId: job.id, activeCount, remainingQueue: queue.length })
      pumpQueue()
    })
  }
}

async function runJob(job) {
  job.status = 'running'
  job.startedAt = Date.now()
  job.abortController = new AbortController()
  const startedAt = Date.now()
  log('info', 'job.started', {
    jobId: job.id,
    username: job.username,
    promptLength: String(job.request.prompt || '').length,
    inputImageCount: Array.isArray(job.request.inputImageDataUrls) ? job.request.inputImageDataUrls.length : 0,
    hasMask: Boolean(job.request.maskDataUrl),
    batch: Boolean(job.request.batch),
    batchCount: job.request.batchCount,
    serverImagePath: job.request.serverImagePath,
  })
  try {
    let requests = [job.request]
    if (job.request.serverImagePath) {
      const files = await listServerImages(job.request.serverImagePath)
      log('info', 'job.server_images.listed', { jobId: job.id, dir: job.request.serverImagePath, count: files.length })
      requests = await Promise.all(files.map(async (filePath) => ({
        ...job.request,
        inputImageDataUrls: [await readImageFileAsDataUrl(filePath)],
        sourceServerPath: filePath,
      })))
    } else if (job.request.batch && job.request.inputImageDataUrls?.length) {
      requests = job.request.inputImageDataUrls.map((image) => ({
        ...job.request,
        inputImageDataUrls: [image],
      }))
    } else if (job.request.batch && !job.request.inputImageDataUrls?.length) {
      const count = Math.max(1, Math.min(200, Number(job.request.batchCount || 1)))
      requests = Array.from({ length: count }, () => ({ ...job.request, inputImageDataUrls: [] }))
    }

    if (job.request.batch) await persistBatchUploads(job, job.request.inputImageDataUrls || [])
    log('info', 'job.request_plan.ready', { jobId: job.id, requestCount: requests.length })

    const allImages = []
    const actualParamsList = []
    const revisedPrompts = []
    const rawImageUrls = []
    for (let i = 0; i < requests.length; i++) {
      const request = requests[i]
      const requestStartedAt = Date.now()
      log('info', 'provider.request.started', {
        jobId: job.id,
        requestIndex: i + 1,
        requestCount: requests.length,
        provider: store.data.settings.activeProfile.provider,
        model: store.data.settings.activeProfile.model,
        apiMode: store.data.settings.activeProfile.apiMode,
        requestType: request.inputImageDataUrls?.length ? 'edit' : 'generate',
        inputImageCount: Array.isArray(request.inputImageDataUrls) ? request.inputImageDataUrls.length : 0,
        hasMask: Boolean(request.maskDataUrl),
        sourceServerPath: request.sourceServerPath,
      })
      const result = await callImageProvider(store.data.settings.activeProfile, request, job.abortController.signal)
      log('info', 'provider.request.done', {
        jobId: job.id,
        requestIndex: i + 1,
        durationMs: Date.now() - requestStartedAt,
        imageCount: result.images.length,
        rawImageUrlCount: result.rawImageUrls?.length || 0,
      })
      allImages.push(...result.images)
      actualParamsList.push(...(result.actualParamsList || result.images.map(() => result.actualParams)))
      revisedPrompts.push(...(result.revisedPrompts || result.images.map(() => undefined)))
      rawImageUrls.push(...(result.rawImageUrls || []))
    }

    const result = {
      images: allImages,
      actualParams: { n: allImages.length },
      actualParamsList,
      revisedPrompts,
      rawImageUrls,
    }
    const records = await persistResult(job, result)
    job.status = 'done'
    job.finishedAt = Date.now()
    job.result = {
      ...result,
      records: records.map((record) => ({
        id: record.id,
        outputUrl: record.outputUrl,
        thumbnailUrl: record.thumbnailUrl,
      })),
    }
    log('info', 'job.done', {
      jobId: job.id,
      username: job.username,
      durationMs: job.finishedAt - startedAt,
      imageCount: allImages.length,
      resultCount: records.length,
    })
  } catch (err) {
    job.status = job.status === 'cancelled' ? 'cancelled' : 'error'
    job.error = err?.name === 'AbortError' ? '请求已取消' : err instanceof Error ? err.message : String(err)
    job.finishedAt = Date.now()
    logError('job.failed', err, {
      jobId: job.id,
      username: job.username,
      status: job.status,
      durationMs: job.finishedAt - startedAt,
    })
  }
}

function cancelJob(job) {
  if (job.status === 'queued') {
    const idx = queue.findIndex((item) => item.id === job.id)
    if (idx >= 0) queue.splice(idx, 1)
    job.status = 'cancelled'
    job.finishedAt = Date.now()
    job.error = '请求已取消'
    log('info', 'job.cancelled', { jobId: job.id, username: job.username, status: 'queued' })
    return true
  }
  return false
}

async function sendFile(res, filePath, cache = false) {
  const ext = path.extname(filePath).toLowerCase()
  const type = ext === '.html' ? 'text/html; charset=utf-8'
    : ext === '.js' ? 'text/javascript; charset=utf-8'
    : ext === '.css' ? 'text/css; charset=utf-8'
    : ext === '.svg' ? 'image/svg+xml'
    : ext === '.png' ? 'image/png'
    : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg'
    : ext === '.webp' ? 'image/webp'
    : 'application/octet-stream'
  try {
    const body = await fs.readFile(filePath)
    send(res, 200, body, { 'Content-Type': type, 'Cache-Control': cache ? 'public, max-age=31536000, immutable' : 'no-store' })
  } catch (err) {
    sendJson(res, { error: err?.code === 'ENOENT' ? 'Not found' : String(err) }, err?.code === 'ENOENT' ? 404 : 500)
  }
}

function filterResults(user, query) {
  const owner = query.searchParams.get('owner')
  const mode = query.searchParams.get('mode')
  return store.data.results.filter((record) => {
    if (user.role !== 'admin') return record.username === user.username && !record.deleted
    if (mode === 'all') return true
    if (owner) return record.username === owner
    return record.username === user.username
  })
}

function paginate(items, url) {
  const page = Math.max(1, Number(url.searchParams.get('page') || 1) || 1)
  const pageSize = Math.max(1, Math.min(PAGE_SIZE_MAX, Number(url.searchParams.get('pageSize') || 40) || 40))
  const total = items.length
  const start = (page - 1) * pageSize
  return {
    items: items.slice(start, start + pageSize),
    page,
    pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  }
}

async function handleApi(req, res, url) {
  if (url.pathname === '/api/session' && req.method === 'GET') {
    const user = currentSession(req)
    return sendJson(res, { user })
  }

  if (url.pathname === '/api/login' && req.method === 'POST') {
    const body = await readJson(req)
    const username = String(body.username || '').trim()
    const password = String(body.password || '')
    let user = null
    if (username === serverConfig.admin.username && verifyPassword(password, store.data.adminPasswordHash)) {
      user = { username, role: 'admin' }
    } else {
      const normal = store.data.users.find((item) => item.username === username && !item.disabled)
      if (normal && verifyPassword(password, normal.passwordHash)) user = { username, role: 'user' }
    }
    if (!user) return sendJson(res, { error: '用户名或密码错误' }, 401)
    const token = crypto.randomBytes(32).toString('hex')
    sessions.set(token, user)
    await addAudit(user, 'auth.login', {}, req)
    log('info', 'auth.login', requestLogDetails(req, user))
    sendJson(res, { user }, 200, { 'Set-Cookie': `gip_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax` })
    return
  }

  if (url.pathname === '/api/logout' && req.method === 'POST') {
    const user = currentSession(req)
    const token = getCookie(req, 'gip_session')
    if (token) sessions.delete(token)
    await addAudit(user, 'auth.logout', {}, req)
    log('info', 'auth.logout', requestLogDetails(req, user))
    sendJson(res, { ok: true }, 200, { 'Set-Cookie': 'gip_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax' })
    return
  }

  if (url.pathname === '/api/admin/users') {
    const admin = requireAdmin(req, res)
    if (!admin) return
    if (req.method === 'GET') return sendJson(res, { users: store.data.users.map(publicUser) })
    if (req.method === 'POST') {
      const body = await readJson(req)
      const username = safeSegment(body.username)
      if (!username || username === serverConfig.admin.username) return sendJson(res, { error: '用户名无效' }, 400)
      if (store.data.users.some((item) => item.username === username)) return sendJson(res, { error: '用户已存在' }, 409)
      const user = {
        username,
        displayName: String(body.displayName || username),
        passwordHash: hashPassword(String(body.password || '123456')),
        disabled: Boolean(body.disabled),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }
      store.data.users.push(user)
      await store.save()
      await addAudit(admin, 'admin.user.create', { username }, req)
      log('info', 'admin.user.create', { ...requestLogDetails(req, admin), targetUsername: username })
      return sendJson(res, { user: publicUser(user) })
    }
  }

  const userMatch = /^\/api\/admin\/users\/([^/]+)$/.exec(url.pathname)
  if (userMatch) {
    const admin = requireAdmin(req, res)
    if (!admin) return
    const username = decodeURIComponent(userMatch[1])
    const user = store.data.users.find((item) => item.username === username)
    if (!user) return sendJson(res, { error: '用户不存在' }, 404)
    if (req.method === 'PATCH') {
      const body = await readJson(req)
      if (body.displayName != null) user.displayName = String(body.displayName)
      if (body.password) user.passwordHash = hashPassword(String(body.password))
      if (body.disabled != null) user.disabled = Boolean(body.disabled)
      user.updatedAt = Date.now()
      await store.save()
      await addAudit(admin, 'admin.user.update', { username, changed: Object.keys(body).filter((key) => key !== 'password') }, req)
      log('info', 'admin.user.update', { ...requestLogDetails(req, admin), targetUsername: username, changed: Object.keys(body).filter((key) => key !== 'password') })
      return sendJson(res, { user: publicUser(user) })
    }
    if (req.method === 'DELETE') {
      store.data.users = store.data.users.filter((item) => item.username !== username)
      await store.save()
      await addAudit(admin, 'admin.user.delete', { username }, req)
      log('info', 'admin.user.delete', { ...requestLogDetails(req, admin), targetUsername: username })
      return sendJson(res, { ok: true })
    }
  }

  if (url.pathname === '/api/admin/settings') {
    const admin = requireAdmin(req, res)
    if (!admin) return
    if (req.method === 'GET') return sendJson(res, { settings: store.data.settings })
    if (req.method === 'PATCH') {
      const body = await readJson(req)
      if (body.concurrency != null) store.data.settings.concurrency = Math.max(1, Math.min(20, Number(body.concurrency) || 2))
      if (body.serverImagePath != null) store.data.settings.serverImagePath = String(body.serverImagePath)
      if (body.activeProfile && typeof body.activeProfile === 'object') {
        store.data.settings.activeProfile = { ...store.data.settings.activeProfile, ...body.activeProfile }
      }
      await store.save()
      pumpQueue()
      await addAudit(admin, 'admin.settings.update', {
        concurrency: store.data.settings.concurrency,
        serverImagePath: store.data.settings.serverImagePath,
        activeProfile: {
          ...store.data.settings.activeProfile,
          apiKey: store.data.settings.activeProfile.apiKey ? '[set]' : '',
        },
      }, req)
      log('info', 'admin.settings.update', {
        ...requestLogDetails(req, admin),
        concurrency: store.data.settings.concurrency,
        serverImagePath: store.data.settings.serverImagePath,
        provider: store.data.settings.activeProfile.provider,
        model: store.data.settings.activeProfile.model,
        hasProviderSecret: Boolean(store.data.settings.activeProfile.apiKey),
      })
      return sendJson(res, { settings: store.data.settings })
    }
  }

  if (url.pathname === '/api/admin/api-keys') {
    const admin = requireAdmin(req, res)
    if (!admin) return
    if (req.method === 'GET') {
      return sendJson(res, { keys: store.data.apiKeys.map((key) => ({ ...key, token: `${key.token.slice(0, 8)}...` })) })
    }
    if (req.method === 'POST') {
      const body = await readJson(req)
      const key = {
        id: id('key'),
        name: String(body.name || 'API Key'),
        token: crypto.randomBytes(32).toString('hex'),
        username: body.username ? safeSegment(body.username) : serverConfig.admin.username,
        role: body.role === 'user' ? 'user' : 'admin',
        disabled: false,
        createdAt: Date.now(),
      }
      store.data.apiKeys.push(key)
      await store.save()
      await addAudit(admin, 'admin.api_key.create', { keyId: key.id, name: key.name, username: key.username, role: key.role }, req)
      log('info', 'admin.backend_token.create', { ...requestLogDetails(req, admin), tokenId: key.id, name: key.name, username: key.username, role: key.role })
      return sendJson(res, { key })
    }
  }

  const keyMatch = /^\/api\/admin\/api-keys\/([^/]+)$/.exec(url.pathname)
  if (keyMatch) {
    const admin = requireAdmin(req, res)
    if (!admin) return
    store.data.apiKeys = store.data.apiKeys.filter((key) => key.id !== decodeURIComponent(keyMatch[1]))
    await store.save()
    await addAudit(admin, 'admin.api_key.delete', { keyId: decodeURIComponent(keyMatch[1]) }, req)
    log('info', 'admin.backend_token.delete', { ...requestLogDetails(req, admin), tokenId: decodeURIComponent(keyMatch[1]) })
    return sendJson(res, { ok: true })
  }

  if (url.pathname === '/api/admin/audit-logs' && req.method === 'GET') {
    const admin = requireAdmin(req, res)
    if (!admin) return
    const page = paginate(store.data.auditLogs, url)
    return sendJson(res, { logs: page.items, page: page.page, pageSize: page.pageSize, total: page.total, totalPages: page.totalPages })
  }

  if (url.pathname === '/api/admin/batch-uploads' && req.method === 'GET') {
    const admin = requireAdmin(req, res)
    if (!admin) return
    const owner = url.searchParams.get('owner')
    const visibleUploads = store.data.batchUploads.filter((record) => {
      if (owner && record.username !== owner) return false
      return !record.deleted
    })
    const page = paginate(visibleUploads, url)
    return sendJson(res, {
      uploads: page.items.map(publicBatchUpload),
      page: page.page,
      pageSize: page.pageSize,
      total: page.total,
      totalPages: page.totalPages,
    })
  }

  const batchUploadMatch = /^\/api\/admin\/batch-uploads\/([^/]+)$/.exec(url.pathname)
  if (batchUploadMatch && req.method === 'DELETE') {
    const admin = requireAdmin(req, res)
    if (!admin) return
    const upload = store.data.batchUploads.find((item) => item.id === decodeURIComponent(batchUploadMatch[1]))
    if (!upload) return sendJson(res, { error: '批量上传原图不存在' }, 404)
    if (!upload.deleted) {
      upload.deleted = true
      upload.deletedAt = Date.now()
      await fs.unlink(upload.filePath).catch((err) => {
        if (err?.code !== 'ENOENT') throw err
      })
      await store.save()
    }
    await addAudit(admin, 'admin.batch_upload.delete', { uploadId: upload.id, owner: upload.username, jobId: upload.jobId }, req)
    log('info', 'admin.batch_upload.delete', { ...requestLogDetails(req, admin), uploadId: upload.id, owner: upload.username, jobId: upload.jobId })
    return sendJson(res, { upload: publicBatchUpload(upload) })
  }

  if (url.pathname === '/api/jobs' && req.method === 'POST') {
    const user = requireAuth(req, res)
    if (!user) return
    const body = await readJson(req)
    if (body.serverImagePath && user.role !== 'admin') return sendJson(res, { error: '服务器图片目录仅管理员可用' }, 403)
    if (body.serverImagePath && String(body.serverImagePath) !== String(store.data.settings.serverImagePath || '')) {
      return sendJson(res, { error: '服务器图片目录必须与管理员设置一致' }, 403)
    }
    const job = {
      id: id('job'),
      username: user.username,
      status: 'queued',
      createdAt: Date.now(),
      startedAt: null,
      finishedAt: null,
      error: null,
      request: body,
      result: null,
    }
    enqueue(job)
    await addAudit(user, 'job.create', {
      jobId: job.id,
      batch: Boolean(body.batch),
      batchCount: body.batchCount,
      inputImageCount: Array.isArray(body.inputImageDataUrls) ? body.inputImageDataUrls.length : 0,
      promptLength: String(body.prompt || '').length,
      serverImagePath: body.serverImagePath ? '[configured]' : '',
    }, req)
    log('info', 'job.create', {
      ...requestLogDetails(req, user),
      jobId: job.id,
      batch: Boolean(body.batch),
      batchCount: body.batchCount,
      inputImageCount: Array.isArray(body.inputImageDataUrls) ? body.inputImageDataUrls.length : 0,
      promptLength: String(body.prompt || '').length,
      serverImagePath: body.serverImagePath ? '[configured]' : '',
    })
    return sendJson(res, { job: getJobView(job) })
  }

  const jobMatch = /^\/api\/jobs\/([^/]+)$/.exec(url.pathname)
  if (jobMatch) {
    const user = requireAuth(req, res)
    if (!user) return
    const job = jobs.get(decodeURIComponent(jobMatch[1]))
    if (!job || (user.role !== 'admin' && job.username !== user.username)) return sendJson(res, { error: '任务不存在' }, 404)
    if (req.method === 'GET') return sendJson(res, { job: getJobView(job) })
    if (req.method === 'DELETE') {
      if (!cancelJob(job)) return sendJson(res, { error: '只能取消排队中的请求' }, 409)
      await addAudit(user, 'job.cancel', { jobId: job.id }, req)
      log('info', 'job.cancel', { ...requestLogDetails(req, user), jobId: job.id })
      return sendJson(res, { job: getJobView(job) })
    }
  }

  if (url.pathname === '/api/gallery' && req.method === 'GET') {
    const user = requireAuth(req, res)
    if (!user) return
    const page = paginate(filterResults(user, url), url)
    return sendJson(res, { results: page.items, page: page.page, pageSize: page.pageSize, total: page.total, totalPages: page.totalPages })
  }

  const galleryImageMatch = /^\/api\/gallery\/([^/]+)\/(image|thumbnail)$/.exec(url.pathname)
  if (galleryImageMatch) {
    const user = requireAuth(req, res)
    if (!user) return
    const record = store.data.results.find((item) => item.id === decodeURIComponent(galleryImageMatch[1]))
    if (!record || (user.role !== 'admin' && (record.username !== user.username || record.deleted))) return sendJson(res, { error: '图片不存在' }, 404)
    return sendFile(res, galleryImageMatch[2] === 'thumbnail' ? record.thumbnailPath : record.outputPath, true)
  }

  const galleryDeleteMatch = /^\/api\/gallery\/([^/]+)$/.exec(url.pathname)
  if (galleryDeleteMatch && req.method === 'DELETE') {
    const admin = requireAdmin(req, res)
    if (!admin) return
    const record = store.data.results.find((item) => item.id === decodeURIComponent(galleryDeleteMatch[1]))
    if (!record) return sendJson(res, { error: '记录不存在' }, 404)
    record.deleted = true
    record.deletedAt = Date.now()
    await store.save()
    await addAudit(admin, 'gallery.delete', { resultId: record.id, owner: record.username, jobId: record.jobId }, req)
    log('info', 'gallery.delete', { ...requestLogDetails(req, admin), resultId: record.id, owner: record.username, jobId: record.jobId })
    return sendJson(res, { record })
  }

  sendJson(res, { error: 'Not found' }, 404)
}

async function handleRequest(req, res) {
  const requestStartedAt = Date.now()
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
    if (url.pathname.startsWith('/api/')) {
      log('info', 'http.api.started', requestLogDetails(req))
      await handleApi(req, res, url)
      log('info', 'http.api.done', { ...requestLogDetails(req), durationMs: Date.now() - requestStartedAt, statusCode: res.statusCode })
      return
    }

    const requested = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)
    const candidate = path.resolve(distDir, `.${requested}`)
    if (candidate.startsWith(distDir)) {
      try {
        const stat = await fs.stat(candidate)
        if (stat.isFile()) return sendFile(res, candidate, requested.startsWith('/assets/'))
      } catch {}
    }
    return sendFile(res, path.join(distDir, 'index.html'))
  } catch (err) {
    logError('http.request.failed', err, { method: req.method, url: req.url, durationMs: Date.now() - requestStartedAt })
    sendJson(res, { error: err instanceof Error ? err.message : String(err) }, 500)
  }
}

await store.init()
await ensureDirs()
await bootstrapAdmin()

http.createServer(handleRequest).listen(serverConfig.port, serverConfig.host, () => {
  log('info', 'server.started', {
    url: `http://${serverConfig.host}:${serverConfig.port}`,
    dataDir: path.resolve(rootDir, serverConfig.dataDir),
    outputDir: path.resolve(rootDir, serverConfig.outputDir),
    thumbnailDir: path.resolve(rootDir, serverConfig.thumbnailDir),
    batchUploadDir: path.resolve(rootDir, serverConfig.batchUploadDir),
    adminUsername: serverConfig.admin.username,
  })
})
