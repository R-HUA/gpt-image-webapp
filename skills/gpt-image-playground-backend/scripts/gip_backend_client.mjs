#!/usr/bin/env node
import { promises as fs } from 'node:fs'
import path from 'node:path'

const DEFAULT_PARAMS = {
  size: 'auto',
  quality: 'auto',
  output_format: 'png',
  output_compression: null,
  moderation: 'auto',
  n: 1,
}

function usage() {
  console.error(`Usage:
  node gip_backend_client.mjs generate --prompt <text> [--image file] [--out-dir dir]

Environment:
  GIP_BACKEND_URL
  GIP_BACKEND_API_KEY
`)
}

function parseArgs(argv) {
  if (argv.includes('--help') || argv.includes('-h')) return { command: 'help', help: true, images: [] }
  const [command, ...rest] = argv
  const args = { command, images: [] }
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i]
    const next = rest[i + 1]
    if (token === '--prompt') args.prompt = rest[++i]
    else if (token === '--image') args.images.push(rest[++i])
    else if (token === '--out-dir') args.outDir = rest[++i]
    else if (token === '--size') args.size = rest[++i]
    else if (token === '--quality') args.quality = rest[++i]
    else if (token === '--format') args.format = rest[++i]
    else if (token === '--n') args.n = Number(rest[++i])
    else if (token === '--batch-count') args.batchCount = Number(rest[++i])
    else if (token === '--timeout-ms') args.timeoutMs = Number(rest[++i])
    else if (token === '--help' || token === '-h') args.help = true
    else throw new Error(`Unknown option: ${token}${next ? ` before ${next}` : ''}`)
  }
  return args
}

function getEnv() {
  const baseUrl = process.env.GIP_BACKEND_URL?.replace(/\/+$/, '')
  const apiKey = process.env.GIP_BACKEND_API_KEY
  if (!baseUrl) throw new Error('GIP_BACKEND_URL is not set')
  if (!apiKey) throw new Error('GIP_BACKEND_API_KEY is not set')
  return { baseUrl, apiKey }
}

function mimeFromPath(filePath) {
  const ext = path.extname(filePath).toLowerCase()
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg'
  if (ext === '.webp') return 'image/webp'
  return 'image/png'
}

async function fileToDataUrl(filePath) {
  const bytes = await fs.readFile(filePath)
  return `data:${mimeFromPath(filePath)};base64,${bytes.toString('base64')}`
}

function dataUrlToBytes(dataUrl) {
  const match = /^data:([^;]+);base64,(.*)$/s.exec(dataUrl)
  if (!match) throw new Error('Backend returned a non-data-url image')
  const mime = match[1]
  const bytes = Buffer.from(match[2], 'base64')
  const ext = mime.includes('jpeg') ? 'jpg' : mime.split('/')[1] || 'png'
  return { bytes, ext }
}

async function api(pathname, init = {}) {
  const { baseUrl, apiKey } = getEnv()
  const response = await fetch(`${baseUrl}${pathname}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`)
  return payload
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

async function generate(args) {
  if (!args.prompt) throw new Error('--prompt is required')

  const params = {
    ...DEFAULT_PARAMS,
    ...(args.size ? { size: args.size } : {}),
    ...(args.quality ? { quality: args.quality } : {}),
    ...(args.format ? { output_format: args.format } : {}),
    ...(args.n ? { n: args.n } : {}),
  }
  const inputImageDataUrls = []
  for (const imagePath of args.images) {
    inputImageDataUrls.push(await fileToDataUrl(imagePath))
  }

  const create = await api('/api/jobs', {
    method: 'POST',
    body: JSON.stringify({
      prompt: args.prompt,
      params,
      inputImageDataUrls,
      batch: Boolean(args.batchCount && args.batchCount > 1),
      batchCount: args.batchCount,
    }),
  })

  const jobId = create.job.id
  const timeoutMs = args.timeoutMs || 600000
  const started = Date.now()
  let job = create.job
  while (job.status === 'queued' || job.status === 'running') {
    if (Date.now() - started > timeoutMs) throw new Error(`Timed out waiting for backend job ${jobId}`)
    await sleep(1500)
    job = (await api(`/api/jobs/${encodeURIComponent(jobId)}`)).job
    const queue = job.queuePosition ? ` queue=${job.queuePosition}` : ''
    console.error(`job=${job.id} status=${job.status}${queue}`)
  }

  if (job.status !== 'done') throw new Error(job.error || `Backend job ended with ${job.status}`)

  const outDir = args.outDir || 'output/gip-backend'
  await fs.mkdir(outDir, { recursive: true })
  const saved = []
  for (let i = 0; i < job.result.images.length; i++) {
    const { bytes, ext } = dataUrlToBytes(job.result.images[i])
    const filePath = path.join(outDir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${job.id}-${i + 1}.${ext}`)
    await fs.writeFile(filePath, bytes)
    saved.push({
      path: filePath,
      resultId: job.result.records?.[i]?.id,
      outputUrl: job.result.records?.[i]?.outputUrl,
      thumbnailUrl: job.result.records?.[i]?.thumbnailUrl,
    })
  }

  console.log(JSON.stringify({ jobId, saved }, null, 2))
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help || !args.command) {
    usage()
    return
  }
  if (args.command !== 'generate') throw new Error(`Unknown command: ${args.command}`)
  await generate(args)
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})
