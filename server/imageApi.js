import { setTimeout as delay } from 'node:timers/promises'

const MIME_MAP = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
}

const PROMPT_REWRITE_GUARD_PREFIX = 'Use the following text as the complete prompt. Do not rewrite it:'

export function normalizeDataUrl(value, fallbackMime) {
  return typeof value === 'string' && value.startsWith('data:')
    ? value
    : `data:${fallbackMime};base64,${value}`
}

export function dataUrlToBuffer(dataUrl) {
  const match = /^data:([^;]+);base64,(.*)$/s.exec(dataUrl)
  if (!match) throw new Error('图片数据不是有效的 data URL')
  const mime = match[1]
  const buffer = Buffer.from(match[2], 'base64')
  const ext = mime.includes('jpeg') ? 'jpg' : mime.split('/')[1] || 'png'
  return { mime, buffer, ext }
}

export function bufferToDataUrl(buffer, mime) {
  return `data:${mime};base64,${Buffer.from(buffer).toString('base64')}`
}

async function readImageUrlAsDataUrl(url, fallbackMime, signal) {
  if (url.startsWith('data:')) return url
  const res = await fetch(url, { cache: 'no-store', signal })
  if (!res.ok) throw new Error(`图片 URL 下载失败：HTTP ${res.status}`)
  const bytes = Buffer.from(await res.arrayBuffer())
  return bufferToDataUrl(bytes, res.headers.get('content-type') || fallbackMime)
}

async function getApiErrorMessage(response) {
  const fallback = `HTTP ${response.status} ${response.statusText || ''}`.trim()
  try {
    const payload = await response.json()
    return {
      message: payload?.error?.message || payload?.message || payload?.detail || fallback,
      bodyPreview: JSON.stringify(payload).slice(0, 2000),
      errorType: payload?.error?.type,
      errorCode: payload?.error?.code,
      errorParam: payload?.error?.param,
    }
  } catch {
    try {
      const text = await response.text()
      return { message: text || fallback, bodyPreview: text.slice(0, 2000) }
    } catch {
      return { message: fallback, bodyPreview: '' }
    }
  }
}

async function throwUpstreamError(response, context) {
  const details = await getApiErrorMessage(response)
  const endpoint = context?.endpoint || response.url
  const message = `上游请求失败：HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''} ${context?.method || 'POST'} ${endpoint} - ${details.message}`
  const err = new Error(message)
  err.name = 'UpstreamRequestError'
  err.upstream = {
    status: response.status,
    statusText: response.statusText,
    endpoint,
    method: context?.method || 'POST',
    provider: context?.provider,
    model: context?.model,
    apiMode: context?.apiMode,
    requestType: context?.requestType,
    inputImageCount: context?.inputImageCount,
    hasMask: context?.hasMask,
    timeoutSeconds: context?.timeoutSeconds,
    errorType: details.errorType,
    errorCode: details.errorCode,
    errorParam: details.errorParam,
    bodyPreview: details.bodyPreview,
  }
  throw err
}

function buildApiUrl(baseUrl, apiPath) {
  const base = String(baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '')
  return `${base}/${apiPath.replace(/^\/+/, '')}`
}

function pickActualParams(source) {
  if (!source || typeof source !== 'object') return {}
  const out = {}
  for (const key of ['size', 'quality', 'output_format', 'output_compression', 'moderation', 'n']) {
    if (source[key] != null) out[key] = source[key]
  }
  return out
}

async function parseImagesPayload(payload, mime, signal) {
  const data = Array.isArray(payload) ? payload : payload?.data
  if (!Array.isArray(data) || data.length === 0) throw new Error('接口没有返回图片数据')

  const images = []
  const revisedPrompts = []
  const rawImageUrls = []
  for (const item of data) {
    if (item?.b64_json) {
      images.push(normalizeDataUrl(item.b64_json, mime))
      revisedPrompts.push(item.revised_prompt)
    } else if (typeof item?.url === 'string') {
      if (/^https?:\/\//i.test(item.url)) rawImageUrls.push(item.url)
      images.push(await readImageUrlAsDataUrl(item.url, mime, signal))
      revisedPrompts.push(item.revised_prompt)
    }
  }
  if (!images.length) throw new Error('接口没有返回可识别的图片数据')
  const actualParams = pickActualParams(payload)
  return {
    images,
    actualParams,
    actualParamsList: images.map(() => actualParams),
    revisedPrompts,
    rawImageUrls,
  }
}

function createResponsesInput(prompt, inputImages) {
  const text = `${PROMPT_REWRITE_GUARD_PREFIX}\n${prompt}`
  if (!inputImages.length) return text
  return [{
    role: 'user',
    content: [
      { type: 'input_text', text },
      ...inputImages.map((image) => ({ type: 'input_image', image_url: image })),
    ],
  }]
}

async function callResponses(profile, request, signal) {
  const params = request.params
  const body = {
    model: profile.model,
    input: createResponsesInput(request.prompt, request.inputImageDataUrls || []),
    tools: [{
      type: 'image_generation',
      action: request.inputImageDataUrls?.length ? 'edit' : 'generate',
      size: params.size,
      quality: params.quality,
      output_format: params.output_format,
      ...(request.maskDataUrl ? { input_image_mask: { image_url: request.maskDataUrl } } : {}),
    }],
    tool_choice: 'required',
  }
  const endpoint = buildApiUrl(profile.baseUrl, 'responses')
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${profile.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal,
  })
  if (!res.ok) await throwUpstreamError(res, {
    endpoint,
    provider: profile.provider,
    model: profile.model,
    apiMode: profile.apiMode,
    requestType: request.inputImageDataUrls?.length ? 'edit' : 'generate',
    inputImageCount: request.inputImageDataUrls?.length || 0,
    hasMask: Boolean(request.maskDataUrl),
  })
  const payload = await res.json()
  const mime = MIME_MAP[params.output_format] || 'image/png'
  const items = Array.isArray(payload.output) ? payload.output.filter((item) => item?.type === 'image_generation_call') : []
  const images = items
    .map((item) => typeof item.result === 'string' ? normalizeDataUrl(item.result, mime) : null)
    .filter(Boolean)
  if (!images.length) throw new Error('接口没有返回可识别的图片数据')
  return {
    images,
    actualParams: { n: images.length },
    actualParamsList: images.map(() => ({})),
    revisedPrompts: items.map((item) => item.revised_prompt),
    rawImageUrls: [],
  }
}

async function callImages(profile, request, signal) {
  const params = request.params
  const mime = MIME_MAP[params.output_format] || 'image/png'
  const timeout = AbortSignal.timeout(Math.max(1, Number(profile.timeout || 300)) * 1000)
  const compositeSignal = signal ? AbortSignal.any([signal, timeout]) : timeout

  if (request.inputImageDataUrls?.length) {
    const form = new FormData()
    form.append('model', profile.model)
    form.append('prompt', request.prompt)
    form.append('size', params.size)
    form.append('quality', params.quality)
    form.append('output_format', params.output_format)
    form.append('moderation', params.moderation)
    if (params.output_compression != null) form.append('output_compression', String(params.output_compression))
    if (params.n > 1) form.append('n', String(params.n))
    if (profile.responseFormatB64Json) form.append('response_format', 'b64_json')
    for (let i = 0; i < request.inputImageDataUrls.length; i++) {
      const { mime: imageMime, buffer, ext } = dataUrlToBuffer(request.inputImageDataUrls[i])
      form.append('image[]', new Blob([buffer], { type: imageMime }), `input-${i + 1}.${ext}`)
    }
    if (request.maskDataUrl) {
      const { buffer } = dataUrlToBuffer(request.maskDataUrl)
      form.append('mask', new Blob([buffer], { type: 'image/png' }), 'mask.png')
    }
    const endpoint = buildApiUrl(profile.baseUrl, 'images/edits')
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${profile.apiKey}` },
      body: form,
      signal: compositeSignal,
    })
    if (!res.ok) await throwUpstreamError(res, {
      endpoint,
      provider: profile.provider,
      model: profile.model,
      apiMode: profile.apiMode,
      requestType: 'edit',
      inputImageCount: request.inputImageDataUrls.length,
      hasMask: Boolean(request.maskDataUrl),
      timeoutSeconds: Math.max(1, Number(profile.timeout || 300)),
    })
    return parseImagesPayload(await res.json(), mime, compositeSignal)
  }

  const body = {
    model: profile.model,
    prompt: request.prompt,
    size: params.size,
    quality: params.quality,
    output_format: params.output_format,
    moderation: params.moderation,
    ...(params.output_compression != null ? { output_compression: params.output_compression } : {}),
    ...(params.n > 1 ? { n: params.n } : {}),
    ...(profile.responseFormatB64Json ? { response_format: 'b64_json' } : {}),
  }
  const endpoint = buildApiUrl(profile.baseUrl, 'images/generations')
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${profile.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: compositeSignal,
  })
  if (!res.ok) await throwUpstreamError(res, {
    endpoint,
    provider: profile.provider,
    model: profile.model,
    apiMode: profile.apiMode,
    requestType: 'generate',
    inputImageCount: 0,
    hasMask: false,
    timeoutSeconds: Math.max(1, Number(profile.timeout || 300)),
  })
  return parseImagesPayload(await res.json(), mime, compositeSignal)
}

export async function callImageProvider(profile, request, signal) {
  await delay(50 + Math.floor(Math.random() * 300), undefined, { signal })
  if (!profile.apiKey) throw new Error('后端尚未配置上游服务商密钥')
  return profile.apiMode === 'responses'
    ? callResponses(profile, request, signal)
    : callImages(profile, request, signal)
}
