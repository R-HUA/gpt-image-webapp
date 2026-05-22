import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_PARAMS } from './types'
import { createDefaultFalProfile, createDefaultOpenAIProfile, DEFAULT_SETTINGS, normalizeSettings } from './lib/apiProfiles'
import type { StoredImage, StoredImageThumbnail, TaskRecord } from './types'
import { getSelectedImageMentionLabel } from './lib/promptImageMentions'
vi.mock('./lib/db', () => {
  const tasks = new Map<string, TaskRecord>()
  const images = new Map<string, StoredImage>()
  const thumbnails = new Map<string, StoredImageThumbnail>()
  let imageSeq = 0

  return {
    CURRENT_THUMBNAIL_VERSION: 2,
    getAllTasks: async () => [...tasks.values()],
    putTask: async (task: TaskRecord) => {
      tasks.set(task.id, task)
      return task.id
    },
    deleteTask: async (id: string) => {
      tasks.delete(id)
    },
    clearTasks: async () => {
      tasks.clear()
    },
    getImage: async (id: string) => images.get(id),
    getImageThumbnail: async (id: string) => thumbnails.get(id),
    getStoredFreshImageThumbnail: async (id: string) => thumbnails.get(id),
    getAllImageIds: async () => [...images.keys()],
    getAllImages: async () => [...images.values()],
    putImage: async (image: StoredImage) => {
      images.set(image.id, image)
      return image.id
    },
    putImageThumbnail: async (thumbnail: StoredImageThumbnail) => {
      thumbnails.set(thumbnail.id, thumbnail)
      return thumbnail.id
    },
    deleteImage: async (id: string) => {
      images.delete(id)
      thumbnails.delete(id)
    },
    clearImages: async () => {
      images.clear()
      thumbnails.clear()
    },
    storeImage: async (dataUrl: string, source: StoredImage['source'] = 'upload') => {
      const id = `stored-image-${++imageSeq}`
      images.set(id, { id, dataUrl, source, createdAt: Date.now() })
      return id
    },
  }
})
const backendJobs: any[] = []
const backendUploads: any[] = []
vi.mock('./lib/backend', () => ({
  uploadBackendInputImage: vi.fn(async (dataUrl) => {
    backendUploads.push(dataUrl)
    return { upload: { id: `backend-upload-${backendUploads.length}`, mime: 'image/png', size: 10, createdAt: Date.now() } }
  }),
  createBackendJob: vi.fn(async (request) => {
    backendJobs.push(request)
    return {
      job: {
        id: `backend-job-${backendJobs.length}`,
        status: 'done',
        queuePosition: 0,
        createdAt: Date.now(),
        startedAt: Date.now(),
        finishedAt: Date.now(),
        error: null,
        progress: null,
        result: {
          images: [],
          actualParams: { n: 0 },
          actualParamsList: [],
          revisedPrompts: [],
          rawImageUrls: [],
          records: [],
        },
      },
    }
  }),
  getBackendJob: vi.fn(),
  cancelBackendJob: vi.fn(),
}))
import { clearImages, clearTasks, putImage, putTask } from './lib/db'
import { countBatchToolCallAttempts, countResponseToolCalls, editOutputs, getPersistedState, getTaskApiProfile, initStore, markInterruptedOpenAIRunningTasks, retryTask, reuseConfig, submitTask, useStore } from './store'

const imageA = { id: 'image-a', dataUrl: 'data:image/png;base64,a' }
const imageB = { id: 'image-b', dataUrl: 'data:image/png;base64,b' }
const getBackendJobMock = vi.mocked((await import('./lib/backend')).getBackendJob)

describe('agent tool budget accounting', () => {
  it('counts image, web search, and continuation function calls but excludes batch wrapper calls', () => {
    expect(countResponseToolCalls([
      { type: 'image_generation_call' },
      { type: 'web_search_call' },
      { type: 'function_call', name: 'continue_generation' },
      { type: 'function_call', name: 'generate_image_batch' },
      { type: 'function_call_output' },
      { type: 'message' },
    ])).toBe(3)
  })

  it('counts batch tool attempts by requested item and treats invalid batches as one attempt', () => {
    expect(countBatchToolCallAttempts({
      arguments: JSON.stringify({
        images: [
          { id: 'a', prompt: 'A', reference_ids: [] },
          { id: 'b', prompt: 'B', reference_ids: ['round-1-image-1'] },
        ],
      }),
    })).toBe(2)
    expect(countBatchToolCallAttempts({ arguments: JSON.stringify({ images: [] }) })).toBe(1)
    expect(countBatchToolCallAttempts({ arguments: '{bad json' })).toBe(1)
  })
})

async function flushAsyncTasks() {
  await Promise.resolve()
  await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
}

function task(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: 'task-a',
    prompt: 'prompt',
    params: { ...DEFAULT_PARAMS },
    inputImageIds: [],
    maskTargetImageId: null,
    maskImageId: null,
    outputImages: [],
    status: 'done',
    error: null,
    createdAt: 1,
    finishedAt: 2,
    elapsed: 1,
    ...overrides,
  }
}

describe('mask draft lifecycle in store actions', () => {
  beforeEach(async () => {
    backendJobs.length = 0
    backendUploads.length = 0
    getBackendJobMock.mockReset()
    await clearTasks()
    await clearImages()
    useStore.setState({
      settings: { ...DEFAULT_SETTINGS, apiKey: 'test-key' },
      prompt: 'prompt',
      inputImages: [],
      batchMode: false,
      batchCount: 1,
      serverImageBatchMode: false,
      maskDraft: null,
      maskEditorImageId: null,
      params: { ...DEFAULT_PARAMS },
      tasks: [],
      detailTaskId: null,
      lightboxImageId: null,
      lightboxImageList: [],
      showSettings: false,
      toast: null,
      confirmDialog: null,
      showToast: vi.fn(),
      setConfirmDialog: vi.fn(),
    })
  })

  it('preserves an existing mask when quick edit-output adds outputs as references', async () => {
    const maskDraft = {
      targetImageId: imageA.id,
      maskDataUrl: 'data:image/png;base64,mask',
      updatedAt: 1,
    }
    useStore.setState({
      inputImages: [imageA],
      maskDraft,
    })

    await editOutputs(task({ outputImages: [imageA.id] }))

    expect(useStore.getState().maskDraft).toEqual(maskDraft)
  })

  it('clears an invalid mask draft when submit cannot find the mask target image', async () => {
    useStore.setState({
      inputImages: [imageA],
      maskDraft: {
        targetImageId: 'missing-image',
        maskDataUrl: 'data:image/png;base64,mask',
        updatedAt: 1,
      },
    })

    await submitTask()

    expect(useStore.getState().maskDraft).toBeNull()
  })

  it('submits uploaded batch images as display children backed by one backend job', async () => {
    await putImage(imageA)
    await putImage(imageB)
    useStore.setState({
      batchMode: true,
      inputImages: [imageA, imageB],
      params: { ...DEFAULT_PARAMS, n: 3 },
    })

    await submitTask()
    await flushAsyncTasks()

    const state = useStore.getState()
    expect(state.tasks).toHaveLength(2)
    expect(state.tasks.map((item) => item.inputImageIds)).toEqual([[imageA.id], [imageB.id]])
    expect(state.tasks.map((item) => item.backendJobOwner)).toEqual([true, false])
    expect(state.tasks.map((item) => [item.batchIndex, item.batchTotal])).toEqual([[1, 2], [2, 2]])
    expect(state.tasks[0].batchId).toBeTruthy()
    expect(state.tasks[1].batchId).toBe(state.tasks[0].batchId)
    expect(state.tasks.every((item) => item.params.n === 1)).toBe(true)
    expect(state.params.n).toBe(3)
    expect(backendJobs).toHaveLength(1)
    expect(backendJobs[0]).toMatchObject({
      batch: true,
      params: expect.objectContaining({ n: 1 }),
    })
    expect(backendJobs[0].settings).toBeUndefined()
    expect(backendUploads).toEqual([imageA.dataUrl, imageB.dataUrl])
    expect(backendJobs[0].inputImageDataUrls).toHaveLength(0)
    expect(backendJobs[0].inputImageUploadIds).toEqual(['backend-upload-1', 'backend-upload-2'])
    expect(backendJobs[0].batchCount).toBeUndefined()
  })

  it('submits no-image batch count to one backend job without changing global n', async () => {
    useStore.setState({
      batchMode: true,
      batchCount: 2,
      inputImages: [],
      params: { ...DEFAULT_PARAMS, n: 4 },
    })

    await submitTask()
    await flushAsyncTasks()

    const state = useStore.getState()
    expect(state.tasks).toHaveLength(2)
    expect(state.tasks[0]).toMatchObject({
      batch: true,
      batchCount: 2,
      batchIndex: 1,
      batchTotal: 2,
      backendJobOwner: true,
      params: expect.objectContaining({ n: 1 }),
    })
    expect(state.tasks[1]).toMatchObject({
      batch: true,
      batchIndex: 2,
      batchTotal: 2,
      backendJobOwner: false,
      params: expect.objectContaining({ n: 1 }),
    })
    expect(state.params.n).toBe(4)
    expect(backendJobs).toHaveLength(1)
    expect(backendJobs[0]).toMatchObject({
      batch: true,
      batchCount: 2,
      params: expect.objectContaining({ n: 1 }),
      inputImageDataUrls: [],
    })
  })

  it('ignores stale local codex cli settings when backend runtime is not codex cli', async () => {
    useStore.setState({
      settings: { ...DEFAULT_SETTINGS, apiKey: 'test-key', codexCli: true, backendCodexCli: false },
      batchMode: true,
      batchCount: 2,
      inputImages: [],
      params: { ...DEFAULT_PARAMS, n: 4 },
    })

    await submitTask()
    await flushAsyncTasks()

    const state = useStore.getState()
    expect(state.tasks).toHaveLength(2)
    expect(state.tasks.map((item) => item.batchIndex)).toEqual([1, 2])
    expect(state.tasks.every((item) => item.batchTotal === 2)).toBe(true)
    expect(backendJobs).toHaveLength(1)
    expect(backendJobs[0]).toMatchObject({
      batch: true,
      batchCount: 2,
      params: expect.objectContaining({ n: 1 }),
    })
  })

  it('uses n as the no-image batch count only when backend runtime is codex cli', async () => {
    useStore.setState({
      settings: { ...DEFAULT_SETTINGS, apiKey: 'test-key', codexCli: false, backendCodexCli: true },
      batchMode: true,
      batchCount: 2,
      inputImages: [],
      params: { ...DEFAULT_PARAMS, n: 4 },
    })

    await submitTask()
    await flushAsyncTasks()

    const state = useStore.getState()
    expect(state.tasks).toHaveLength(4)
    expect(state.tasks.map((item) => item.batchIndex)).toEqual([1, 2, 3, 4])
    expect(state.tasks.every((item) => item.batchTotal === 4)).toBe(true)
    expect(backendJobs).toHaveLength(1)
    expect(backendJobs[0]).toMatchObject({
      batch: true,
      batchCount: 4,
      params: expect.objectContaining({ n: 1 }),
    })
  })

  it('retries a batch child as an independent task', async () => {
    const failedBatchTask = task({
      status: 'error',
      batch: true,
      batchId: 'batch-a',
      batchCount: 1,
      batchIndex: 1,
      batchTotal: 2,
      serverImagePath: '/input-images',
    })
    useStore.setState({ tasks: [failedBatchTask] })

    await retryTask(failedBatchTask)

    const retried = useStore.getState().tasks[0]
    expect(retried.id).not.toBe(failedBatchTask.id)
    expect(retried.batch).toBe(false)
    expect(retried.batchId).toBeUndefined()
    expect(retried.batchIndex).toBeUndefined()
    expect(retried.batchTotal).toBeUndefined()
    expect(retried.serverImagePath).toBeUndefined()
  })

  it('passes the configured server image path for admin server-directory jobs', async () => {
    useStore.setState({
      settings: { ...DEFAULT_SETTINGS, adminServerImagePath: '/input-images' },
      serverImageBatchMode: true,
      batchMode: true,
      inputImages: [],
    })

    await submitTask()
    await flushAsyncTasks()

    expect(useStore.getState().tasks).toHaveLength(1)
    expect(useStore.getState().tasks[0].serverImagePath).toBe('/input-images')
    expect(backendJobs).toHaveLength(1)
    expect(backendJobs[0].serverImagePath).toBe('/input-images')
  })

  it('finishes a restored backend job from persisted gallery records', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn(async () => new Response(new Blob(['image-bytes'], { type: 'image/png' }))) as typeof fetch
    vi.stubGlobal('window', {})
    try {
      const runningTask = task({
        id: 'restored-backend-job',
        status: 'running',
        backendJobId: 'backend-job-restored',
        createdAt: 1_000,
        finishedAt: null,
        elapsed: null,
      })
      getBackendJobMock.mockResolvedValueOnce({
        job: {
          id: 'backend-job-restored',
          status: 'done',
          queuePosition: 0,
          createdAt: 1_000,
          startedAt: 1_100,
          finishedAt: 2_000,
          error: null,
          progress: null,
          result: {
            images: [],
            actualParams: { n: 1 },
            actualParamsList: [{ n: 1 }],
            revisedPrompts: [],
            rawImageUrls: [],
            records: [{ id: 'record-1', outputUrl: '/api/gallery/record-1/image', thumbnailUrl: '/api/gallery/record-1/thumbnail' }],
          },
        },
      })
      await putTask(runningTask)
      useStore.setState({ tasks: [runningTask] })

      await initStore()
      await flushAsyncTasks()

      const completed = useStore.getState().tasks.find((item) => item.id === runningTask.id)
      expect(completed).toMatchObject({
        status: 'done',
        outputImages: [expect.stringMatching(/^stored-image-\d+$/)],
        finishedAt: 2_000,
        queuePosition: 0,
      })
      expect(globalThis.fetch).toHaveBeenCalledWith('/api/gallery/record-1/image', {
        credentials: 'include',
        cache: 'no-store',
      })
    } finally {
      globalThis.fetch = originalFetch
      vi.unstubAllGlobals()
    }
  })

  it('maps one backend batch job results back to each display child by request index', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn(async () => new Response(new Blob(['image-bytes'], { type: 'image/png' }))) as typeof fetch
    try {
      const childA = task({
        id: 'batch-child-a',
        status: 'running',
        batch: true,
        batchId: 'batch-job',
        batchIndex: 1,
        batchTotal: 2,
        backendJobOwner: true,
        backendJobId: 'backend-job-batch',
        inputImageIds: [imageA.id],
        createdAt: 1_000,
        finishedAt: null,
        elapsed: null,
      })
      const childB = task({
        id: 'batch-child-b',
        status: 'running',
        batch: true,
        batchId: 'batch-job',
        batchIndex: 2,
        batchTotal: 2,
        backendJobOwner: false,
        backendJobId: 'backend-job-batch',
        inputImageIds: [imageB.id],
        createdAt: 1_001,
        finishedAt: null,
        elapsed: null,
      })
      getBackendJobMock.mockResolvedValueOnce({
        job: {
          id: 'backend-job-batch',
          status: 'done',
          queuePosition: 0,
          createdAt: 1_000,
          startedAt: 1_100,
          finishedAt: 2_000,
          error: null,
          progress: { total: 2, completed: 2, failed: 0, current: null },
          result: {
            images: [],
            actualParams: { n: 2 },
            actualParamsList: [{ n: 1 }, { n: 1 }],
            revisedPrompts: [],
            rawImageUrls: [],
            requestIndexes: [1, 2],
            records: [
              { id: 'record-a', outputUrl: '/api/gallery/record-a/image', thumbnailUrl: '/api/gallery/record-a/thumbnail', requestIndex: 1 },
              { id: 'record-b', outputUrl: '/api/gallery/record-b/image', thumbnailUrl: '/api/gallery/record-b/thumbnail', requestIndex: 2 },
            ],
          },
        },
      })
      await putTask(childA)
      await putTask(childB)
      useStore.setState({ tasks: [childA, childB] })

      await initStore()
      await flushAsyncTasks()

      const completedA = useStore.getState().tasks.find((item) => item.id === childA.id)
      const completedB = useStore.getState().tasks.find((item) => item.id === childB.id)
      expect(completedA).toMatchObject({
        status: 'done',
        inputImageIds: [imageA.id],
        outputImages: [expect.stringMatching(/^stored-image-\d+$/)],
      })
      expect(completedB).toMatchObject({
        status: 'done',
        inputImageIds: [imageB.id],
        outputImages: [expect.stringMatching(/^stored-image-\d+$/)],
      })
      expect(completedA?.outputImages[0]).not.toBe(completedB?.outputImages[0])
      expect(getBackendJobMock).toHaveBeenCalledTimes(1)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('syncs backend progress while polling a restored batch job', async () => {
    vi.useFakeTimers()
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn(async () => new Response(new Blob(['image-bytes'], { type: 'image/png' }))) as typeof fetch
    try {
      const runningTask = task({
        id: 'restored-progress-job',
        status: 'running',
        backendJobId: 'backend-job-progress',
        createdAt: 1_000,
        finishedAt: null,
        elapsed: null,
      })
      getBackendJobMock
        .mockResolvedValueOnce({
          job: {
            id: 'backend-job-progress',
            status: 'running',
            queuePosition: 0,
            createdAt: 1_000,
            startedAt: 1_100,
            finishedAt: null,
            error: null,
            progress: { total: 3, completed: 1, failed: 0, current: 2 },
            result: null,
          },
        })
        .mockResolvedValueOnce({
          job: {
            id: 'backend-job-progress',
            status: 'done',
            queuePosition: 0,
            createdAt: 1_000,
            startedAt: 1_100,
            finishedAt: 2_000,
            error: null,
            progress: { total: 3, completed: 3, failed: 0, current: null },
            result: {
              images: [],
              actualParams: { n: 1 },
              actualParamsList: [{ n: 1 }],
              revisedPrompts: [],
              rawImageUrls: [],
              records: [{ id: 'record-progress', outputUrl: '/api/gallery/record-progress/image', thumbnailUrl: '/api/gallery/record-progress/thumbnail' }],
            },
          },
        })
      await putTask(runningTask)
      useStore.setState({ tasks: [runningTask] })

      await initStore()
      await Promise.resolve()
      await Promise.resolve()

      expect(useStore.getState().tasks.find((item) => item.id === runningTask.id)?.backendProgress).toEqual({
        total: 3,
        completed: 1,
        failed: 0,
        current: 2,
      })

      await vi.advanceTimersByTimeAsync(1200)
      await Promise.resolve()

      expect(useStore.getState().tasks.find((item) => item.id === runningTask.id)).toMatchObject({
        status: 'done',
        backendProgress: undefined,
      })
    } finally {
      globalThis.fetch = originalFetch
      vi.useRealTimers()
    }
  })

  it('marks only actively running backend batch children as running', async () => {
    vi.useFakeTimers()
    try {
      const children = [1, 2, 3].map((index) => task({
        id: `batch-child-${index}`,
        status: 'running',
        batch: true,
        batchId: 'batch-progress',
        batchIndex: index,
        batchTotal: 3,
        backendJobOwner: index === 1,
        backendJobId: 'backend-job-running-batch',
        createdAt: 1_000 + index,
        finishedAt: null,
        elapsed: null,
      }))
      getBackendJobMock
        .mockResolvedValueOnce({
          job: {
            id: 'backend-job-running-batch',
            status: 'running',
            queuePosition: 0,
            createdAt: 1_000,
            startedAt: 1_100,
            finishedAt: null,
            error: null,
            progress: { total: 3, completed: 0, failed: 0, current: 2, running: [2], maxStarted: 2 },
            result: null,
          },
        })
        .mockResolvedValueOnce({
          job: {
            id: 'backend-job-running-batch',
            status: 'done',
            queuePosition: 0,
            createdAt: 1_000,
            startedAt: 1_100,
            finishedAt: 2_000,
            error: null,
            progress: { total: 3, completed: 3, failed: 0, current: null, running: [], maxStarted: 3 },
            result: {
              images: [
                'data:image/png;base64,a',
                'data:image/png;base64,b',
                'data:image/png;base64,c',
              ],
              actualParams: { n: 3 },
              actualParamsList: [{ n: 1 }, { n: 1 }, { n: 1 }],
              revisedPrompts: [],
              rawImageUrls: [],
              requestIndexes: [1, 2, 3],
            },
          },
        })
      await Promise.all(children.map((child) => putTask(child)))
      useStore.setState({ tasks: children })

      await initStore()
      await Promise.resolve()
      await Promise.resolve()

      expect(useStore.getState().tasks.map((item) => [item.batchIndex, item.status])).toEqual([
        [1, 'queued'],
        [2, 'running'],
        [3, 'queued'],
      ])

      await vi.advanceTimersByTimeAsync(1200)
      await Promise.resolve()

      expect(useStore.getState().tasks.every((item) => item.status === 'done')).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('marks completed backend jobs recoverable when local result sync fails and retries the same job', async () => {
    const originalFetch = globalThis.fetch
    const fetchMock = vi.fn()
    fetchMock
      .mockResolvedValueOnce(new Response('failed', { status: 500 }))
      .mockResolvedValueOnce(new Response(new Blob(['image-bytes'], { type: 'image/png' })))
    globalThis.fetch = fetchMock as typeof fetch
    try {
      const runningTask = task({
        id: 'recoverable-backend-job',
        status: 'running',
        backendJobId: 'backend-job-recoverable',
        createdAt: 1_000,
        finishedAt: null,
        elapsed: null,
      })
      const doneJob = {
        id: 'backend-job-recoverable',
        status: 'done' as const,
        queuePosition: 0,
        createdAt: 1_000,
        startedAt: 1_100,
        finishedAt: 2_000,
        error: null,
        progress: { total: 1, completed: 1, failed: 0, current: null },
        result: {
          images: [],
          actualParams: { n: 1 },
          actualParamsList: [{ n: 1 }],
          revisedPrompts: [],
          rawImageUrls: [],
          records: [{ id: 'record-recoverable', outputUrl: '/api/gallery/record-recoverable/image', thumbnailUrl: '/api/gallery/record-recoverable/thumbnail' }],
        },
      }
      getBackendJobMock.mockResolvedValueOnce({ job: doneJob })
      await putTask(runningTask)
      useStore.setState({ tasks: [runningTask] })

      await initStore()
      await flushAsyncTasks()

      const failedSync = useStore.getState().tasks.find((item) => item.id === runningTask.id)
      expect(failedSync).toMatchObject({
        status: 'error',
        backendJobId: 'backend-job-recoverable',
        backendRecoverable: true,
      })

      getBackendJobMock.mockResolvedValueOnce({ job: doneJob })
      await retryTask(failedSync!)
      await flushAsyncTasks()

      expect(useStore.getState().tasks.find((item) => item.id === runningTask.id)).toMatchObject({
        status: 'done',
        backendJobId: 'backend-job-recoverable',
        backendRecoverable: false,
        outputImages: [expect.stringMatching(/^stored-image-\d+$/)],
      })
      expect(backendJobs).toHaveLength(0)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('preserves selected image mentions when replacing a mask target with an equivalent image id', () => {
    const replacement = { id: 'image-a-replacement', dataUrl: imageA.dataUrl }
    const prompt = `参考 ${getSelectedImageMentionLabel(0)} 生成`
    useStore.setState({
      prompt,
      inputImages: [imageA, imageB],
    })

    useStore.getState().setInputImages([replacement, imageB], {
      equivalentImageIds: { [imageA.id]: replacement.id },
    })

    const state = useStore.getState()
    expect(state.inputImages.map((img) => img.id)).toEqual([replacement.id, imageB.id])
    expect(state.prompt).toBe(prompt)
  })
})

describe('interrupted OpenAI running tasks', () => {
  it('marks legacy and OpenAI running tasks as interrupted', () => {
    const now = 10_000
    const legacyRunning = task({ id: 'legacy-running', status: 'running', createdAt: 1_000, finishedAt: null, elapsed: null })
    const openAIRunning = task({ id: 'openai-running', apiProvider: 'openai', status: 'running', createdAt: 2_000, finishedAt: null, elapsed: null })
    const falRunning = task({ id: 'fal-running', apiProvider: 'fal', status: 'running', createdAt: 3_000, finishedAt: null, elapsed: null })
    const customAsyncRunning = task({ id: 'custom-running', apiProvider: 'custom-provider', customTaskId: 'task-1', status: 'running', createdAt: 4_000, finishedAt: null, elapsed: null })
    const doneTask = task({ id: 'done-task', apiProvider: 'openai', status: 'done' })

    const result = markInterruptedOpenAIRunningTasks([legacyRunning, openAIRunning, falRunning, customAsyncRunning, doneTask], now)

    expect(result.interruptedTasks.map((item) => item.id)).toEqual(['legacy-running', 'openai-running'])
    expect(result.tasks.find((item) => item.id === 'legacy-running')).toMatchObject({
      status: 'error',
      error: expect.stringContaining('请求中断'),
      finishedAt: now,
      elapsed: 9_000,
    })
    expect(result.tasks.find((item) => item.id === 'openai-running')).toMatchObject({
      status: 'error',
      error: expect.stringContaining('请求中断'),
      finishedAt: now,
      elapsed: 8_000,
    })
    expect(result.tasks.find((item) => item.id === 'fal-running')).toEqual(falRunning)
    expect(result.tasks.find((item) => item.id === 'custom-running')).toEqual(customAsyncRunning)
    expect(result.tasks.find((item) => item.id === 'done-task')).toEqual(doneTask)
  })
})

describe('input persistence setting', () => {
  beforeEach(() => {
    useStore.setState({
      settings: { ...DEFAULT_SETTINGS },
      prompt: 'prompt',
      inputImages: [imageA],
      dismissedCodexCliPrompts: [],
    })
  })

  it('persists input when restart input restore is enabled', () => {
    const persisted = getPersistedState(useStore.getState())

    expect(persisted.prompt).toBe('prompt')
    expect(persisted.inputImages).toEqual([{ id: imageA.id, dataUrl: '' }])
  })

  it('omits input when restart input restore is disabled', () => {
    useStore.setState({ settings: { ...DEFAULT_SETTINGS, persistInputOnRestart: false } })

    const persisted = getPersistedState(useStore.getState())

    expect(persisted).not.toHaveProperty('prompt')
    expect(persisted).not.toHaveProperty('inputImages')
  })

  it('writes empty input when persisted input is cleared', () => {
    useStore.setState({ prompt: '', inputImages: [] })

    const persisted = getPersistedState(useStore.getState())

    expect(persisted.prompt).toBe('')
    expect(persisted.inputImages).toEqual([])
  })
})

describe('reused task API profile', () => {
  const openaiProfile = createDefaultOpenAIProfile({ id: 'openai-profile', apiKey: 'openai-key' })
  const falProfile = createDefaultFalProfile({ id: 'fal-profile', name: 'fal 配置', apiKey: 'fal-key' })

  beforeEach(() => {
    useStore.setState({
      settings: normalizeSettings({
        ...DEFAULT_SETTINGS,
        profiles: [openaiProfile, falProfile],
        activeProfileId: openaiProfile.id,
        reuseTaskApiProfileTemporarily: true,
      }),
      prompt: '',
      inputImages: [],
      maskDraft: null,
      params: { ...DEFAULT_PARAMS },
      tasks: [],
      showSettings: false,
      toast: null,
      reusedTaskApiProfileId: null,
      reusedTaskApiProfileName: null,
      reusedTaskApiProfileMissing: false,
      showToast: vi.fn(),
      setConfirmDialog: vi.fn(),
    })
  })

  it('resolves a task API profile by stored profile id', () => {
    const resolved = getTaskApiProfile(useStore.getState().settings, task({ apiProvider: 'fal', apiProfileId: falProfile.id }))

    expect(resolved?.id).toBe(falProfile.id)
  })

  it('reuses the task API profile temporarily without switching the active profile', async () => {
    await reuseConfig(task({
      apiProvider: 'fal',
      apiProfileId: falProfile.id,
      params: { ...DEFAULT_PARAMS, n: 8, size: 'auto', quality: 'auto' },
    }))

    const state = useStore.getState()
    expect(state.settings.activeProfileId).toBe(openaiProfile.id)
    expect(state.reusedTaskApiProfileId).toBe(falProfile.id)
    expect(state.params).toMatchObject({ n: 4, size: '1360x1024', quality: 'high' })
    expect(state.showToast).toHaveBeenCalledWith('已临时复用该任务的 API 配置「fal 配置」', 'success')
  })

  it('keeps selected image mentions when reusing a task with different current input images', async () => {
    await clearImages()
    await putImage(imageA)
    await putImage(imageB)
    const taskPrompt = `参考 ${getSelectedImageMentionLabel(1)} 生成`

    useStore.setState({
      prompt: `当前 ${getSelectedImageMentionLabel(1)}`,
      inputImages: [
        { id: 'current-x', dataUrl: 'data:image/png;base64,x' },
        { id: 'current-y', dataUrl: 'data:image/png;base64,y' },
      ],
    })

    await reuseConfig(task({
      apiProvider: 'openai',
      apiProfileId: openaiProfile.id,
      prompt: taskPrompt,
      inputImageIds: [imageA.id, imageB.id],
    }))

    const state = useStore.getState()
    expect(state.inputImages.map((img) => img.id)).toEqual([imageA.id, imageB.id])
    expect(state.prompt).toBe(taskPrompt)
  })

  it('clears temporary reuse when switching current settings to the reused API profile', async () => {
    await reuseConfig(task({ apiProvider: 'fal', apiProfileId: falProfile.id }))

    useStore.getState().setSettings({ activeProfileId: falProfile.id })

    const state = useStore.getState()
    expect(state.settings.activeProfileId).toBe(falProfile.id)
    expect(state.reusedTaskApiProfileId).toBeNull()
    expect(state.reusedTaskApiProfileMissing).toBe(false)
  })

  it('normalizes reused params to the current API profile when temporary reuse is disabled', async () => {
    useStore.setState({
      settings: normalizeSettings({
        ...useStore.getState().settings,
        reuseTaskApiProfileTemporarily: false,
      }),
    })

    await reuseConfig(task({
      apiProvider: 'fal',
      apiProfileId: falProfile.id,
      params: { ...DEFAULT_PARAMS, n: 8, size: 'auto', quality: 'auto' },
    }))

    const state = useStore.getState()
    expect(state.settings.activeProfileId).toBe(openaiProfile.id)
    expect(state.reusedTaskApiProfileId).toBeNull()
    expect(state.params).toMatchObject({ n: 8, size: 'auto', quality: 'auto' })
  })

  it('asks whether to submit with current API profile when the reused API profile is missing', async () => {
    await reuseConfig(task({ apiProvider: 'fal', apiProfileId: 'missing-profile' }))

    const state = useStore.getState()
    expect(state.tasks).toEqual([])
    expect(state.setConfirmDialog).toHaveBeenCalledWith(expect.objectContaining({
      title: '找不到 API 配置',
      message: '找不到复用任务所使用的 API 配置「未知配置」，要使用当前的 API 配置「默认」提交任务吗？',
      confirmText: '使用当前配置提交',
      cancelText: '放弃提交',
    }))
    expect(state.showSettings).toBe(false)
  })
})

describe('final sync output reuse and terminal status protection', () => {
  const originalFetch = globalThis.fetch
  
  beforeEach(async () => {
    backendJobs.length = 0
    backendUploads.length = 0
    getBackendJobMock.mockReset()
    await clearTasks()
    await clearImages()
    useStore.setState({
      settings: { ...DEFAULT_SETTINGS, apiKey: 'test-key' },
      tasks: [],
      toast: null,
      showToast: vi.fn(),
    })
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('reuses already-downloaded sibling outputs and avoids duplicate downloads', async () => {
    globalThis.fetch = vi.fn(async () => new Response(new Blob(['image-bytes'], { type: 'image/png' }))) as typeof fetch

    const childOwner = task({
      id: 'task-owner',
      status: 'running',
      batch: true,
      batchId: 'batch-sync-test',
      batchIndex: 1,
      batchTotal: 3,
      backendJobOwner: true,
      backendJobId: 'backend-job-sync-test',
      createdAt: 1_000,
    })
    const childRunning = task({
      id: 'task-running-sibling',
      status: 'running',
      batch: true,
      batchId: 'batch-sync-test',
      batchIndex: 2,
      batchTotal: 3,
      backendJobOwner: false,
      backendJobId: 'backend-job-sync-test',
      createdAt: 1_001,
    })
    const childDone = task({
      id: 'task-done-sibling',
      status: 'done',
      batch: true,
      batchId: 'batch-sync-test',
      batchIndex: 3,
      batchTotal: 3,
      backendJobOwner: false,
      backendJobId: 'backend-job-sync-test',
      outputImages: ['existing-stored-img'],
      createdAt: 1_002,
    })

    getBackendJobMock.mockResolvedValueOnce({
      job: {
        id: 'backend-job-sync-test',
        status: 'done',
        queuePosition: 0,
        createdAt: 1_000,
        startedAt: 1_100,
        finishedAt: 2_000,
        error: null,
        progress: { total: 3, completed: 3, failed: 0, current: null },
        result: {
          images: [],
          actualParams: { n: 3 },
          actualParamsList: [{ n: 1 }, { n: 1 }, { n: 1 }],
          revisedPrompts: [],
          rawImageUrls: [],
          requestIndexes: [1, 2, 3],
          records: [
            { id: 'record-a', outputUrl: '/api/gallery/record-a/image', thumbnailUrl: '', requestIndex: 1 },
            { id: 'record-b', outputUrl: '/api/gallery/record-b/image', thumbnailUrl: '', requestIndex: 2 },
            { id: 'record-c', outputUrl: '/api/gallery/record-c/image', thumbnailUrl: '', requestIndex: 3 },
          ],
        },
      },
    })

    await putTask(childOwner)
    await putTask(childRunning)
    await putTask(childDone)
    useStore.setState({ tasks: [childOwner, childRunning, childDone] })

    await initStore()
    await flushAsyncTasks()

    const completedOwner = useStore.getState().tasks.find((item) => item.id === childOwner.id)
    const completedRunning = useStore.getState().tasks.find((item) => item.id === childRunning.id)
    const completedDone = useStore.getState().tasks.find((item) => item.id === childDone.id)

    expect(completedDone?.outputImages).toEqual(['existing-stored-img'])
    expect(completedDone?.status).toBe('done')

    expect(completedOwner?.status).toBe('done')
    expect(completedOwner?.outputImages[0]).toMatch(/^stored-image-\d+$/)
    
    expect(completedRunning?.status).toBe('done')
    expect(completedRunning?.outputImages[0]).toMatch(/^stored-image-\d+$/)

    expect(globalThis.fetch).toHaveBeenCalledTimes(2)
  })

  it('protects terminal sibling statuses from being overridden during polling and final sync', async () => {
    globalThis.fetch = vi.fn(async () => new Response(new Blob(['image-bytes'], { type: 'image/png' }))) as typeof fetch

    const childDone = task({
      id: 'task-sibling-done',
      status: 'done',
      batch: true,
      batchId: 'batch-protect-test',
      batchIndex: 1,
      batchTotal: 3,
      backendJobOwner: false,
      backendJobId: 'backend-job-protect-test',
      outputImages: ['existing-stored-img'],
      createdAt: 1_000,
    })
    const childCancelled = task({
      id: 'task-sibling-cancelled',
      status: 'cancelled',
      batch: true,
      batchId: 'batch-protect-test',
      batchIndex: 2,
      batchTotal: 3,
      backendJobOwner: false,
      backendJobId: 'backend-job-protect-test',
      createdAt: 1_001,
    })
    const childRunningOwner = task({
      id: 'task-sibling-running-owner',
      status: 'running',
      batch: true,
      batchId: 'batch-protect-test',
      batchIndex: 3,
      batchTotal: 3,
      backendJobOwner: true,
      backendJobId: 'backend-job-protect-test',
      createdAt: 1_002,
    })

    getBackendJobMock.mockResolvedValueOnce({
      job: {
        id: 'backend-job-protect-test',
        status: 'done',
        queuePosition: 0,
        createdAt: 1_000,
        startedAt: 1_100,
        finishedAt: 2_000,
        error: null,
        progress: { total: 3, completed: 3, failed: 0, current: null },
        result: {
          images: [],
          actualParams: { n: 3 },
          actualParamsList: [{ n: 1 }, { n: 1 }, { n: 1 }],
          revisedPrompts: [],
          rawImageUrls: [],
          requestIndexes: [1, 2, 3],
          records: [
            { id: 'record-a', outputUrl: '/api/gallery/record-a/image', thumbnailUrl: '', requestIndex: 1 },
            { id: 'record-b', outputUrl: '/api/gallery/record-b/image', thumbnailUrl: '', requestIndex: 2 },
            { id: 'record-c', outputUrl: '/api/gallery/record-c/image', thumbnailUrl: '', requestIndex: 3 },
          ],
        },
      },
    })

    await putTask(childDone)
    await putTask(childCancelled)
    await putTask(childRunningOwner)
    useStore.setState({ tasks: [childDone, childCancelled, childRunningOwner] })

    await initStore()
    await flushAsyncTasks()

    const resultDone = useStore.getState().tasks.find((item) => item.id === childDone.id)
    const resultCancelled = useStore.getState().tasks.find((item) => item.id === childCancelled.id)
    const resultRunning = useStore.getState().tasks.find((item) => item.id === childRunningOwner.id)

    expect(resultDone?.status).toBe('done')
    expect(resultDone?.outputImages).toEqual(['existing-stored-img'])

    expect(resultCancelled?.status).toBe('cancelled')
    expect(resultCancelled?.outputImages).toEqual([])

    expect(resultRunning?.status).toBe('done')
    expect(resultRunning?.outputImages[0]).toMatch(/^stored-image-\d+$/)
  })

  it('resyncs an error backend-recoverable task without creating a new backend job', async () => {
    globalThis.fetch = vi.fn(async () => new Response(new Blob(['image-bytes'], { type: 'image/png' }))) as typeof fetch

    const recoverableTask = task({
      id: 'task-error-recoverable',
      status: 'error',
      error: '后端任务已完成，但同步结果失败：HTTP 500',
      backendJobId: 'backend-job-error-recoverable',
      backendRecoverable: true,
      createdAt: 1_000,
      finishedAt: 2_000,
      elapsed: 1_000,
    })

    getBackendJobMock.mockResolvedValueOnce({
      job: {
        id: 'backend-job-error-recoverable',
        status: 'done',
        queuePosition: 0,
        createdAt: 1_000,
        startedAt: 1_100,
        finishedAt: 2_000,
        error: null,
        progress: null,
        result: {
          images: [],
          actualParams: { n: 1 },
          actualParamsList: [{ n: 1 }],
          revisedPrompts: [],
          rawImageUrls: [],
          records: [
            { id: 'record-resync', outputUrl: '/api/gallery/record-resync/image', thumbnailUrl: '', requestIndex: 1 },
          ],
        },
      },
    })

    await putTask(recoverableTask)
    useStore.setState({ tasks: [recoverableTask] })

    await initStore()
    await flushAsyncTasks()

    expect(useStore.getState().tasks.find((item) => item.id === recoverableTask.id)).toMatchObject({
      status: 'done',
      backendJobId: 'backend-job-error-recoverable',
      backendRecoverable: false,
      outputImages: [expect.stringMatching(/^stored-image-\d+$/)],
    })
    expect(backendJobs).toHaveLength(0)
    expect(globalThis.fetch).toHaveBeenCalledTimes(1)
  })

  it('keeps completed siblings done when final sync fails for an unfinished sibling', async () => {
    globalThis.fetch = vi.fn(async () => new Response('failed', { status: 500 })) as typeof fetch

    const childDone = task({
      id: 'task-final-sync-done',
      status: 'done',
      batch: true,
      batchId: 'batch-final-sync-failure',
      batchIndex: 1,
      batchTotal: 2,
      backendJobOwner: false,
      backendJobId: 'backend-job-final-sync-failure',
      outputImages: ['existing-stored-img'],
      createdAt: 1_000,
    })
    const childOwner = task({
      id: 'task-final-sync-owner',
      status: 'running',
      batch: true,
      batchId: 'batch-final-sync-failure',
      batchIndex: 2,
      batchTotal: 2,
      backendJobOwner: true,
      backendJobId: 'backend-job-final-sync-failure',
      createdAt: 1_001,
      finishedAt: null,
      elapsed: null,
    })

    getBackendJobMock.mockResolvedValueOnce({
      job: {
        id: 'backend-job-final-sync-failure',
        status: 'done',
        queuePosition: 0,
        createdAt: 1_000,
        startedAt: 1_100,
        finishedAt: 2_000,
        error: null,
        progress: { total: 2, completed: 2, failed: 0, current: null },
        result: {
          images: [],
          actualParams: { n: 2 },
          actualParamsList: [{ n: 1 }, { n: 1 }],
          revisedPrompts: [],
          rawImageUrls: [],
          requestIndexes: [1, 2],
          records: [
            { id: 'record-done', outputUrl: '/api/gallery/record-done/image', thumbnailUrl: '', requestIndex: 1 },
            { id: 'record-fails', outputUrl: '/api/gallery/record-fails/image', thumbnailUrl: '', requestIndex: 2 },
          ],
        },
      },
    })

    await putTask(childDone)
    await putTask(childOwner)
    useStore.setState({ tasks: [childDone, childOwner] })

    await initStore()
    await flushAsyncTasks()

    expect(useStore.getState().tasks.find((item) => item.id === childDone.id)).toMatchObject({
      status: 'done',
      outputImages: ['existing-stored-img'],
      backendRecoverable: false,
    })
    expect(useStore.getState().tasks.find((item) => item.id === childOwner.id)).toMatchObject({
      status: 'error',
      backendJobId: 'backend-job-final-sync-failure',
      backendRecoverable: true,
    })
    expect(globalThis.fetch).toHaveBeenCalledTimes(1)
  })
})
