import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type {
  ApiProfile,
  AppSettings,
  TaskParams,
  InputImage,
  MaskDraft,
  TaskRecord,
  ExportData,
} from './types'
import { DEFAULT_PARAMS } from './types'
import { DEFAULT_SETTINGS, getActiveApiProfile, getCustomProviderDefinition, mergeImportedSettings, normalizeSettings } from './lib/apiProfiles'
import { dismissAllTooltips } from './lib/tooltipDismiss'
import { remapImageMentionsForOrder, replaceImageMentionsForApi } from './lib/promptImageMentions'
import {
  CURRENT_THUMBNAIL_VERSION,
  getAllTasks,
  putTask,
  deleteTask as dbDeleteTask,
  clearTasks as dbClearTasks,
  getImage,
  getImageThumbnail,
  getStoredFreshImageThumbnail,
  getAllImageIds,
  getAllImages,
  putImage,
  putImageThumbnail,
  deleteImage,
  clearImages,
  storeImage,
} from './lib/db'
import { cancelBackendJob, createBackendJob, getBackendJob, patchBackendJob, uploadBackendInputImage } from './lib/backend'
import type { BackendJob, BackendJobResult } from './lib/backend'
import { getFalErrorMessage, getFalQueuedImageResult } from './lib/falAiImageApi'
import { getCustomQueuedImageResult } from './lib/openaiCompatibleImageApi'
import { validateMaskMatchesImage } from './lib/canvasImage'
import { orderInputImagesForMask } from './lib/mask'
import { getChangedParams, normalizeParamsForSettings } from './lib/paramCompatibility'
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate'

// ===== Image cache =====
// 内存缓存，id → dataUrl。只保留少量最近使用图片，避免大量 4K data URL 常驻内存。

const imageCache = new Map<string, string>()
const thumbnailCache = new Map<string, { dataUrl: string; width?: number; height?: number; thumbnailVersion?: number }>()
const thumbnailBackfillIds = new Map<string, 'visible' | 'background'>()
const thumbnailBackfillRunningIds = new Set<string>()
const thumbnailSubscribers = new Map<string, Set<(thumbnail: { dataUrl: string; width?: number; height?: number }) => void>>()
let thumbnailBackfillScheduled = false
const MAX_IMAGE_CACHE_ENTRIES = 8
const MAX_THUMBNAIL_CACHE_ENTRIES = 80
const MAX_THUMBNAIL_BACKFILL_CONCURRENT = 4
const FAL_RECOVERY_POLL_MS = 10_000
const CUSTOM_RECOVERY_POLL_MS = 10_000
const SUPPORT_PROMPT_IMAGE_THRESHOLD = 50
const falRecoveryTimers = new Map<string, ReturnType<typeof setTimeout>>()
const customRecoveryTimers = new Map<string, ReturnType<typeof setTimeout>>()
const openAIWatchdogTimers = new Map<string, ReturnType<typeof setTimeout>>()
const completedBatchToasts = new Set<string>()
const OPENAI_INTERRUPTED_ERROR = '请求中断'
const BACKEND_JOB_POLL_RETRY_MS = 3_000

function createOpenAITimeoutError(timeoutSeconds: number) {
  return `请求超时：超过 ${timeoutSeconds} 秒仍未完成，请稍后重试或提高超时时间。`
}

export function getCachedImage(id: string): string | undefined {
  const dataUrl = imageCache.get(id)
  if (dataUrl) {
    imageCache.delete(id)
    imageCache.set(id, dataUrl)
  }
  return dataUrl
}

function cacheImage(id: string, dataUrl: string) {
  imageCache.delete(id)
  imageCache.set(id, dataUrl)
  while (imageCache.size > MAX_IMAGE_CACHE_ENTRIES) {
    const oldestKey = imageCache.keys().next().value
    if (oldestKey == null) break
    imageCache.delete(oldestKey)
  }
}

function getCachedThumbnail(id: string) {
  const thumbnail = thumbnailCache.get(id)
  if (thumbnail?.thumbnailVersion === CURRENT_THUMBNAIL_VERSION) {
    thumbnailCache.delete(id)
    thumbnailCache.set(id, thumbnail)
    return thumbnail
  }
  if (thumbnail) {
    thumbnailCache.delete(id)
  }
  return undefined
}

function cacheThumbnail(id: string, thumbnail: { dataUrl: string; width?: number; height?: number; thumbnailVersion?: number }) {
  if (thumbnail.thumbnailVersion !== CURRENT_THUMBNAIL_VERSION) return
  thumbnailCache.delete(id)
  thumbnailCache.set(id, thumbnail)
  while (thumbnailCache.size > MAX_THUMBNAIL_CACHE_ENTRIES) {
    const oldestKey = thumbnailCache.keys().next().value
    if (oldestKey == null) break
    thumbnailCache.delete(oldestKey)
  }
}

export async function ensureImageCached(id: string): Promise<string | undefined> {
  const cached = getCachedImage(id)
  if (cached) return cached
  const rec = await getImage(id)
  if (rec) {
    cacheImage(id, rec.dataUrl)
    return rec.dataUrl
  }
  return undefined
}

export async function ensureImageThumbnailCached(id: string): Promise<{ dataUrl: string; width?: number; height?: number } | undefined> {
  const cached = getCachedThumbnail(id)
  if (cached) return cached

  const rec = await getStoredFreshImageThumbnail(id)
  if (!rec?.thumbnailDataUrl) {
    scheduleThumbnailBackfill([id], 'visible')
    return undefined
  }

  const thumbnail = {
    dataUrl: rec.thumbnailDataUrl,
    width: rec.width,
    height: rec.height,
    thumbnailVersion: rec.thumbnailVersion,
  }
  cacheThumbnail(id, thumbnail)
  return thumbnail
}

export function subscribeImageThumbnail(id: string, callback: (thumbnail: { dataUrl: string; width?: number; height?: number }) => void) {
  let subscribers = thumbnailSubscribers.get(id)
  if (!subscribers) {
    subscribers = new Set()
    thumbnailSubscribers.set(id, subscribers)
  }
  subscribers.add(callback)
  return () => {
    subscribers?.delete(callback)
    if (subscribers?.size === 0) thumbnailSubscribers.delete(id)
  }
}

function notifyImageThumbnail(id: string, thumbnail: { dataUrl: string; width?: number; height?: number }) {
  thumbnailSubscribers.get(id)?.forEach((callback) => callback(thumbnail))
}

function scheduleThumbnailBackfill(ids: Iterable<string>, priority: 'visible' | 'background' = 'background') {
  for (const id of ids) {
    if (getCachedThumbnail(id) || thumbnailBackfillRunningIds.has(id)) continue
    const currentPriority = thumbnailBackfillIds.get(id)
    if (!currentPriority || priority === 'visible') thumbnailBackfillIds.set(id, priority)
  }
  scheduleThumbnailBackfillTick()
}

function scheduleThumbnailBackfillTick() {
  if (thumbnailBackfillScheduled || thumbnailBackfillIds.size === 0) return
  thumbnailBackfillScheduled = true

  const run = () => {
    thumbnailBackfillScheduled = false
    void processNextThumbnailBackfill()
  }

  if ('requestIdleCallback' in window) {
    window.requestIdleCallback(run, { timeout: 2_000 })
  } else {
    globalThis.setTimeout(run, 250)
  }
}

async function processNextThumbnailBackfill() {
  if (thumbnailBackfillRunningIds.size > 0) return

  const ids = await getNextThumbnailBackfillBatch()
  for (const id of ids) startThumbnailBackfill(id)

  if (thumbnailBackfillIds.size > 0) scheduleThumbnailBackfillTick()
}

async function getNextThumbnailBackfillBatch() {
  const candidates = getOrderedThumbnailBackfillIds().slice(0, MAX_THUMBNAIL_BACKFILL_CONCURRENT)
  if (candidates.length === 0) return []

  const sizes = await Promise.all(candidates.map(async (id) => {
    const image = await getImage(id)
    return { width: image?.width, height: image?.height }
  }))
  const concurrency = getThumbnailConcurrencyForBatch(sizes)
  const selected = candidates.slice(0, concurrency)
  for (const id of selected) thumbnailBackfillIds.delete(id)
  return selected
}

function getOrderedThumbnailBackfillIds() {
  const visible: string[] = []
  const background: string[] = []
  for (const [id, priority] of thumbnailBackfillIds) {
    if (priority === 'visible') visible.push(id)
    else background.push(id)
  }
  return [...visible, ...background]
}

function getThumbnailConcurrencyForBatch(sizes: Array<{ width?: number; height?: number }>) {
  let maxMegapixels = 0
  for (const { width, height } of sizes) {
    if (!width || !height) return 1
    maxMegapixels = Math.max(maxMegapixels, (width * height) / 1_000_000)
  }
  const megapixels = maxMegapixels
  if (megapixels >= 8) return 1
  if (megapixels >= 4) return 2
  if (megapixels >= 2) return 3
  return 4
}

function startThumbnailBackfill(id: string) {
  thumbnailBackfillRunningIds.add(id)

  void (async () => {
    if (getCachedThumbnail(id)) return

    const thumbnail = await getImageThumbnail(id)
    if (thumbnail?.thumbnailDataUrl) {
      cacheThumbnail(id, {
        dataUrl: thumbnail.thumbnailDataUrl,
        width: thumbnail.width,
        height: thumbnail.height,
        thumbnailVersion: thumbnail.thumbnailVersion,
      })
      notifyImageThumbnail(id, {
        dataUrl: thumbnail.thumbnailDataUrl,
        width: thumbnail.width,
        height: thumbnail.height,
      })
    }
  })().catch(() => {
    // Keep thumbnail generation best-effort; cards remain on placeholders if it fails.
  }).finally(() => {
    thumbnailBackfillRunningIds.delete(id)
    scheduleThumbnailBackfillTick()
  })
}

function orderImagesWithMaskFirst(images: InputImage[], maskTargetImageId: string | null | undefined) {
  if (!maskTargetImageId) return images
  const maskIdx = images.findIndex((img) => img.id === maskTargetImageId)
  if (maskIdx <= 0) return images
  const next = [...images]
  const [maskImage] = next.splice(maskIdx, 1)
  next.unshift(maskImage)
  return next
}

function countSuccessfulOutputImages(tasks: TaskRecord[]) {
  return tasks.reduce((count, task) => count + (task.status === 'done' ? task.outputImages.length : 0), 0)
}

function skipSupportPromptForImportedData(tasks: TaskRecord[]) {
  const count = countSuccessfulOutputImages(tasks)
  useStore.setState((state) => {
    if (state.supportPromptDismissed) return {}
    if (count <= SUPPORT_PROMPT_IMAGE_THRESHOLD) {
      return { supportPromptSkippedForImportedData: false }
    }
    if (state.supportPromptOpen) return {}
    return { supportPromptSkippedForImportedData: true }
  })
}

function showSupportPromptForExistingLocalData(tasks: TaskRecord[]) {
  const count = countSuccessfulOutputImages(tasks)
  useStore.setState((state) => {
    if (state.supportPromptDismissed || state.supportPromptOpen) return {}
    if (count <= SUPPORT_PROMPT_IMAGE_THRESHOLD) {
      return { supportPromptSkippedForImportedData: false }
    }
    if (state.supportPromptSkippedForImportedData) return {}
    return { supportPromptOpen: true }
  })
}

function maybeOpenSupportPrompt(previousTasks: TaskRecord[], nextTasks: TaskRecord[], taskId: string) {
  const state = useStore.getState()
  if (state.supportPromptDismissed || state.supportPromptOpen || state.supportPromptSkippedForImportedData) return

  const previousTask = previousTasks.find((task) => task.id === taskId)
  const nextTask = nextTasks.find((task) => task.id === taskId)
  if (!nextTask || previousTask?.status === 'done' || nextTask.status !== 'done' || nextTask.outputImages.length === 0) return

  const previousCount = countSuccessfulOutputImages(previousTasks)
  const nextCount = countSuccessfulOutputImages(nextTasks)
  if (previousCount <= SUPPORT_PROMPT_IMAGE_THRESHOLD && nextCount > SUPPORT_PROMPT_IMAGE_THRESHOLD) {
    useStore.setState({ supportPromptOpen: true })
  }
}

export function getPersistedState(state: AppState) {
  const settings = normalizeSettings(state.settings)
  const { backendCodexCli: _backendCodexCli, ...persistedSettings } = settings
  return {
    settings: persistedSettings,
    params: state.params,
    ...(settings.persistInputOnRestart
      ? {
          prompt: state.prompt,
          inputImages: state.inputImages.map((img) => ({ id: img.id, dataUrl: '' })),
        }
      : {}),
    dismissedCodexCliPrompts: state.dismissedCodexCliPrompts,
    supportPromptDismissed: state.supportPromptDismissed,
    supportPromptOpen: state.supportPromptOpen,
    supportPromptSkippedForImportedData: state.supportPromptSkippedForImportedData,
  }
}

function mergePersistedState(persistedState: unknown, currentState: AppState): AppState {
  if (!persistedState || typeof persistedState !== 'object') return currentState

  const persisted = persistedState as Partial<AppState>
  const settings = normalizeSettings(persisted.settings ?? currentState.settings)
  return {
    ...currentState,
    ...persisted,
    settings,
    supportPromptDismissed: Boolean(persisted.supportPromptDismissed),
    supportPromptOpen: Boolean(persisted.supportPromptOpen),
    supportPromptSkippedForImportedData: Boolean(persisted.supportPromptSkippedForImportedData),
    prompt: settings.persistInputOnRestart && typeof persisted.prompt === 'string' ? persisted.prompt : '',
    inputImages: settings.persistInputOnRestart && Array.isArray(persisted.inputImages) ? persisted.inputImages : [],
  }
}

// ===== Store 类型 =====

interface AppState {
  // 设置
  settings: AppSettings
  setSettings: (s: Partial<AppSettings>) => void
  dismissedCodexCliPrompts: string[]
  dismissCodexCliPrompt: (key: string) => void

  // 输入
  prompt: string
  setPrompt: (p: string) => void
  inputImages: InputImage[]
  addInputImage: (img: InputImage) => void
  removeInputImage: (idx: number) => void
  clearInputImages: () => void
  setInputImages: (imgs: InputImage[], options?: { equivalentImageIds?: Record<string, string> }) => void
  moveInputImage: (fromIdx: number, toIdx: number) => void
  batchMode: boolean
  setBatchMode: (v: boolean) => void
  batchCount: number
  setBatchCount: (v: number) => void
  serverImageBatchMode: boolean
  setServerImageBatchMode: (v: boolean) => void
  maskDraft: MaskDraft | null
  setMaskDraft: (draft: MaskDraft | null) => void
  clearMaskDraft: () => void
  maskEditorImageId: string | null
  setMaskEditorImageId: (id: string | null) => void

  // 参数
  params: TaskParams
  setParams: (p: Partial<TaskParams>) => void
  reusedTaskApiProfileId: string | null
  reusedTaskApiProfileName: string | null
  reusedTaskApiProfileMissing: boolean
  setReusedTaskApiProfile: (profileId: string | null, missing?: boolean, profileName?: string | null) => void

  // 任务列表
  tasks: TaskRecord[]
  setTasks: (t: TaskRecord[]) => void

  // 搜索和筛选
  searchQuery: string
  setSearchQuery: (q: string) => void
  filterStatus: 'all' | 'queued' | 'running' | 'done' | 'error' | 'cancelled'
  setFilterStatus: (status: AppState['filterStatus']) => void
  filterFavorite: boolean
  setFilterFavorite: (f: boolean) => void

  // 多选
  selectedTaskIds: string[]
  setSelectedTaskIds: (ids: string[] | ((prev: string[]) => string[])) => void
  toggleTaskSelection: (id: string, force?: boolean) => void
  clearSelection: () => void

  // UI
  detailTaskId: string | null
  setDetailTaskId: (id: string | null) => void
  lightboxImageId: string | null
  lightboxImageList: string[]
  setLightboxImageId: (id: string | null, list?: string[]) => void
  showSettings: boolean
  setShowSettings: (v: boolean) => void
  supportPromptOpen: boolean
  supportPromptDismissed: boolean
  supportPromptSkippedForImportedData: boolean
  setSupportPromptOpen: (v: boolean) => void
  dismissSupportPrompt: () => void

  // Toast
  toast: { message: string; type: 'info' | 'success' | 'error' } | null
  showToast: (message: string, type?: 'info' | 'success' | 'error') => void

  // Confirm dialog
  confirmDialog: {
    title: string
    message: string
    confirmText?: string
    cancelText?: string
    showCancel?: boolean
    icon?: 'info' | 'copy'
    minConfirmDelayMs?: number
    messageAlign?: 'left' | 'center'
    tone?: 'danger' | 'warning'
    action: () => void
    cancelAction?: () => void
  } | null
  setConfirmDialog: (d: AppState['confirmDialog']) => void

  // Batch detail modal
  batchDetailBatchId: string | null
  setBatchDetailBatchId: (id: string | null) => void
}

export const useStore = create<AppState>()(
  persist(
    (set, get) => ({
      // Settings
      settings: { ...DEFAULT_SETTINGS },
      setSettings: (s) => set((st) => {
        const previous = normalizeSettings(st.settings)
        const incoming = s as Partial<AppSettings>
        const hasLegacyOverrides =
          incoming.baseUrl !== undefined ||
          incoming.apiKey !== undefined ||
          incoming.model !== undefined ||
          incoming.timeout !== undefined ||
          incoming.apiMode !== undefined ||
          incoming.codexCli !== undefined ||
          incoming.apiProxy !== undefined
        const merged = normalizeSettings({ ...previous, ...incoming })
        if (hasLegacyOverrides && incoming.profiles === undefined) {
          merged.profiles = merged.profiles.map((profile) =>
            profile.id === merged.activeProfileId
              ? {
                  ...profile,
                  baseUrl: incoming.baseUrl ?? profile.baseUrl,
                  apiKey: incoming.apiKey ?? profile.apiKey,
                  model: incoming.model ?? profile.model,
                  timeout: incoming.timeout ?? profile.timeout,
                  apiMode: incoming.apiMode === 'images' || incoming.apiMode === 'responses' ? incoming.apiMode : profile.apiMode,
                  codexCli: incoming.codexCli ?? profile.codexCli,
                  apiProxy: incoming.apiProxy ?? profile.apiProxy,
                }
              : profile,
          )
        }
        const settings = normalizeSettings(merged)
        const shouldClearReusedProfile = st.reusedTaskApiProfileId && settings.activeProfileId === st.reusedTaskApiProfileId
        return {
          settings,
          ...(shouldClearReusedProfile
            ? { reusedTaskApiProfileId: null, reusedTaskApiProfileName: null, reusedTaskApiProfileMissing: false }
            : {}),
        }
      }),
      dismissedCodexCliPrompts: [],
      dismissCodexCliPrompt: (key) => set((st) => ({
        dismissedCodexCliPrompts: st.dismissedCodexCliPrompts.includes(key)
          ? st.dismissedCodexCliPrompts
          : [...st.dismissedCodexCliPrompts, key],
      })),

      // Input
      prompt: '',
      setPrompt: (prompt) => set({ prompt }),
      inputImages: [],
      addInputImage: (img) =>
        set((s) => {
          if (s.inputImages.find((i) => i.id === img.id)) return s
          return { inputImages: [...s.inputImages, img] }
        }),
      removeInputImage: (idx) =>
        set((s) => {
          const removed = s.inputImages[idx]
          const inputImages = s.inputImages.filter((_, i) => i !== idx)
          const shouldClearMask = removed?.id === s.maskDraft?.targetImageId
          return {
            inputImages,
            prompt: remapImageMentionsForOrder(s.prompt, s.inputImages, inputImages),
            ...(shouldClearMask ? { maskDraft: null, maskEditorImageId: null } : {}),
          }
        }),
      clearInputImages: () =>
        set((s) => {
          for (const img of s.inputImages) imageCache.delete(img.id)
          return {
            inputImages: [],
            prompt: remapImageMentionsForOrder(s.prompt, s.inputImages, []),
            maskDraft: null,
            maskEditorImageId: null,
          }
        }),
      setInputImages: (imgs, options) =>
        set((s) => {
          const inputImages = orderImagesWithMaskFirst(imgs, s.maskDraft?.targetImageId)
          const shouldClearMask =
            Boolean(s.maskDraft) && !inputImages.some((img) => img.id === s.maskDraft?.targetImageId)
          return {
            inputImages,
            prompt: remapImageMentionsForOrder(s.prompt, s.inputImages, inputImages, options?.equivalentImageIds),
            ...(shouldClearMask ? { maskDraft: null, maskEditorImageId: null } : {}),
          }
        }),
      moveInputImage: (fromIdx, toIdx) =>
        set((s) => {
          const images = [...s.inputImages]
          if (fromIdx < 0 || fromIdx >= images.length) return s
          const maskTargetImageId = s.maskDraft?.targetImageId
          if (maskTargetImageId && images[fromIdx]?.id === maskTargetImageId) return s
          const minTargetIdx = maskTargetImageId && images.some((img) => img.id === maskTargetImageId) ? 1 : 0
          const targetIdx = Math.max(minTargetIdx, Math.min(images.length, toIdx))
          const insertIdx = fromIdx < targetIdx ? targetIdx - 1 : targetIdx
          if (insertIdx === fromIdx) return s
          const [moved] = images.splice(fromIdx, 1)
          images.splice(insertIdx, 0, moved)
          return {
            inputImages: images,
            prompt: remapImageMentionsForOrder(s.prompt, s.inputImages, images),
          }
        }),
      batchMode: false,
      setBatchMode: (batchMode) => set({ batchMode }),
      batchCount: 1,
      setBatchCount: (batchCount) => set({ batchCount: Math.max(1, Math.min(200, Math.floor(batchCount) || 1)) }),
      serverImageBatchMode: false,
      setServerImageBatchMode: (serverImageBatchMode) => set({ serverImageBatchMode }),
      maskDraft: null,
      setMaskDraft: (maskDraft) =>
        set((s) => {
          const inputImages = orderImagesWithMaskFirst(s.inputImages, maskDraft?.targetImageId)
          return {
            maskDraft,
            inputImages,
            prompt: remapImageMentionsForOrder(s.prompt, s.inputImages, inputImages),
          }
        }),
      clearMaskDraft: () => set({ maskDraft: null }),
      maskEditorImageId: null,
      setMaskEditorImageId: (maskEditorImageId) => {
        if (maskEditorImageId) dismissAllTooltips()
        set({ maskEditorImageId })
      },

      // Params
      params: { ...DEFAULT_PARAMS },
      setParams: (p) => set((s) => ({ params: { ...s.params, ...p } })),
      reusedTaskApiProfileId: null,
      reusedTaskApiProfileName: null,
      reusedTaskApiProfileMissing: false,
      setReusedTaskApiProfile: (profileId, missing = false, profileName = null) => set({
        reusedTaskApiProfileId: profileId,
        reusedTaskApiProfileName: profileName,
        reusedTaskApiProfileMissing: missing,
      }),

      // Tasks
      tasks: [],
      setTasks: (tasks) => set(() => ({
        tasks,
        ...(countSuccessfulOutputImages(tasks) <= SUPPORT_PROMPT_IMAGE_THRESHOLD
          ? { supportPromptSkippedForImportedData: false }
          : {}),
      })),

      // Search & Filter
      searchQuery: '',
      setSearchQuery: (searchQuery) => set({ searchQuery }),
      filterStatus: 'all',
      setFilterStatus: (filterStatus) => set({ filterStatus }),
      filterFavorite: false,
      setFilterFavorite: (filterFavorite) => set({ filterFavorite }),

      // Selection
      selectedTaskIds: [],
      setSelectedTaskIds: (updater) => set((s) => ({
        selectedTaskIds: typeof updater === 'function' ? updater(s.selectedTaskIds) : updater
      })),
      toggleTaskSelection: (id, force) => set((s) => {
        const isSelected = s.selectedTaskIds.includes(id)
        const shouldSelect = force !== undefined ? force : !isSelected
        if (shouldSelect === isSelected) return s
        return {
          selectedTaskIds: shouldSelect
            ? [...s.selectedTaskIds, id]
            : s.selectedTaskIds.filter((x) => x !== id)
        }
      }),
      clearSelection: () => set({ selectedTaskIds: [] }),

      // UI
      detailTaskId: null,
      setDetailTaskId: (detailTaskId) => {
        if (detailTaskId) dismissAllTooltips()
        set({ detailTaskId })
      },
      lightboxImageId: null,
      lightboxImageList: [],
      setLightboxImageId: (lightboxImageId, list) => {
        if (lightboxImageId) dismissAllTooltips()
        set({ lightboxImageId, lightboxImageList: list ?? (lightboxImageId ? [lightboxImageId] : []) })
      },
      showSettings: false,
      setShowSettings: (showSettings) => {
        if (showSettings) dismissAllTooltips()
        set({ showSettings })
      },
      supportPromptOpen: false,
      supportPromptDismissed: false,
      supportPromptSkippedForImportedData: false,
      setSupportPromptOpen: (supportPromptOpen) => set({ supportPromptOpen }),
      dismissSupportPrompt: () => set({ supportPromptOpen: false, supportPromptDismissed: true }),

      // Toast
      toast: null,
      showToast: (message, type = 'info') => {
        set({ toast: { message, type } })
        setTimeout(() => {
          set((s) => (s.toast?.message === message ? { toast: null } : s))
        }, 3000)
      },

      // Confirm
      confirmDialog: null,
      setConfirmDialog: (confirmDialog) => {
        if (confirmDialog) dismissAllTooltips()
        set({ confirmDialog })
      },

      // Batch detail modal
      batchDetailBatchId: null,
      setBatchDetailBatchId: (batchDetailBatchId) => set({ batchDetailBatchId }),
    }),
    {
      name: 'gpt-image-playground',
      partialize: getPersistedState,
      merge: mergePersistedState,
    },
  ),
)

// ===== Actions =====

let uid = 0
function genId(): string {
  return Date.now().toString(36) + (++uid).toString(36) + Math.random().toString(36).slice(2, 6)
}

function getBatchSiblings(task: TaskRecord): TaskRecord[] {
  if (!task.batch || !task.batchId) return []
  return useStore.getState().tasks
    .filter((item) => item.batchId === task.batchId)
    .sort((a, b) => (a.batchIndex || 0) - (b.batchIndex || 0))
}

function getBackendJobOwner(task: TaskRecord): TaskRecord {
  if (!task.batchId) return task
  return getBatchSiblings(task).find((item) => item.backendJobOwner) || task
}

function shouldExecuteBackendJob(task: TaskRecord): boolean {
  return task.backendJobOwner !== false
}

function maybeShowBatchCompletionToast(task: TaskRecord): boolean {
  if (!task.batch || !task.batchId || !task.batchTotal || task.batchTotal <= 1) return false
  const siblings = getBatchSiblings(task)
  const total = task.batchTotal
  if (siblings.length < total) return true

  const doneCount = siblings.filter((item) => item.status === 'done').length
  const errorCount = siblings.filter((item) => item.status === 'error').length
  const cancelledCount = siblings.filter((item) => item.status === 'cancelled').length
  const failedCount = errorCount + cancelledCount
  const partialFailedCount = siblings.reduce((sum, item) => (
    sum + (item.partialFailure ? item.failedCount || item.requestErrors?.length || 0 : 0)
  ), 0)
  if (doneCount + failedCount < total) return true
  if (completedBatchToasts.has(task.batchId)) return true
  completedBatchToasts.add(task.batchId)

  if (failedCount > 0 || partialFailedCount > 0) {
    const parts = [`批量任务完成 ${doneCount}/${total}`]
    if (failedCount > 0) parts.push(`${failedCount} 个失败或取消`)
    if (partialFailedCount > 0) parts.push(`${partialFailedCount} 个子请求失败`)
    useStore.getState().showToast(parts.join('，'), failedCount === total ? 'error' : 'success')
  } else {
    useStore.getState().showToast(`批量任务全部完成 (${total}/${total})`, 'success')
  }
  return true
}

export function getCodexCliPromptKey(settings: AppSettings): string {
  const profile = getActiveApiProfile(settings)
  return `${profile.baseUrl}\n${profile.apiKey}`
}

function isOpenAITask(task: TaskRecord) {
  return (task.apiProvider ?? 'openai') !== 'fal'
}

function isRunningOpenAITask(task: TaskRecord) {
  return task.status === 'running' && isOpenAITask(task)
}

function isAsyncCustomProviderTask(settings: AppSettings, provider: string, hasInputImages: boolean) {
  const customProvider = getCustomProviderDefinition(settings, provider)
  if (!customProvider?.poll) return false
  const submitMapping = hasInputImages && customProvider.editSubmit ? customProvider.editSubmit : customProvider.submit
  return Boolean(submitMapping.taskIdPath)
}

export function markInterruptedOpenAIRunningTasks(tasks: TaskRecord[], now = Date.now()) {
  const interruptedTasks: TaskRecord[] = []
  const updatedTasks = tasks.map((task) => {
    if (!isRunningOpenAITask(task) || task.customTaskId || task.backendJobId) return task

    const updated: TaskRecord = {
      ...task,
      status: 'error',
      error: OPENAI_INTERRUPTED_ERROR,
      falRecoverable: false,
      finishedAt: now,
      elapsed: Math.max(0, now - task.createdAt),
    }
    interruptedTasks.push(updated)
    return updated
  })

  return { tasks: updatedTasks, interruptedTasks }
}

function isMissingBackendJobError(err: unknown) {
  return /任务不存在|job not found|not found/i.test(err instanceof Error ? err.message : String(err))
}

function isBackendJobPollRecoverableError(err: unknown) {
  if (isMissingBackendJobError(err)) return false
  const status = err && typeof err === 'object' && 'status' in err
    ? Number((err as { status?: unknown }).status)
    : 0
  if (status) return status === 502 || status === 503 || status === 504
  return isApiRequestNetworkError(err)
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function blobToDataUrl(blob: Blob): Promise<string> {
  if (typeof FileReader !== 'undefined') {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result || ''))
      reader.onerror = () => reject(reader.error || new Error('读取图片失败'))
      reader.readAsDataURL(blob)
    })
  }

  return blob.arrayBuffer().then((buffer) => {
    const bytes = new Uint8Array(buffer)
    let binary = ''
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
    return `data:${blob.type || 'application/octet-stream'};base64,${btoa(binary)}`
  })
}

async function fetchBackendResultImage(record: { outputUrl: string }) {
  const response = await fetch(record.outputUrl, {
    credentials: 'include',
    cache: 'no-store',
  })
  if (!response.ok) throw new Error(`读取后端结果图片失败：HTTP ${response.status}`)
  return blobToDataUrl(await response.blob())
}

async function getBackendResultOutputs(
  result: NonNullable<BackendJobResult>,
  existingByRequestIndex?: Map<number, string[]>
): Promise<Array<{
  dataUrl?: string
  imageId?: string
  requestIndex: number
  actualParams?: Partial<TaskParams>
  revisedPrompt?: string
  rawImageUrl?: string
}>> {
  const outputs: Array<{
    dataUrl?: string
    imageId?: string
    requestIndex: number
    actualParams?: Partial<TaskParams>
    revisedPrompt?: string
    rawImageUrl?: string
  }> = []

  if (result.records?.length) {
    for (let index = 0; index < result.records.length; index++) {
      const record = result.records[index]
      const requestIndex = record.requestIndex ?? result.requestIndexes?.[index] ?? index + 1
      const actualParams = result.actualParamsList?.[index] || result.actualParams
      const revisedPrompt = result.revisedPrompts?.[index]
      const rawImageUrl = result.rawImageUrls?.[index]

      const existingIds = existingByRequestIndex?.get(requestIndex)
      if (existingIds && existingIds.length > 0) {
        outputs.push({
          imageId: existingIds[0],
          requestIndex,
          actualParams,
          revisedPrompt,
          rawImageUrl,
        })
      } else {
        const dataUrl = await fetchBackendResultImage(record)
        outputs.push({
          dataUrl,
          requestIndex,
          actualParams,
          revisedPrompt,
          rawImageUrl,
        })
      }
    }
    return outputs
  }

  return (result.images || []).map((dataUrl, index) => ({
    dataUrl,
    requestIndex: result.requestIndexes?.[index] ?? index + 1,
    actualParams: result.actualParamsList?.[index] || result.actualParams,
    revisedPrompt: result.revisedPrompts?.[index],
    rawImageUrl: result.rawImageUrls?.[index],
  }))
}

function clearOpenAIWatchdogTimer(taskId: string) {
  const timer = openAIWatchdogTimers.get(taskId)
  if (timer) clearTimeout(timer)
  openAIWatchdogTimers.delete(taskId)
}

function failOpenAITaskIfStillRunning(taskId: string, error: string, now = Date.now()) {
  const task = useStore.getState().tasks.find((item) => item.id === taskId)
  if (!task || !isRunningOpenAITask(task)) return false

  updateTaskInStore(taskId, {
    status: 'error',
    error,
    falRecoverable: false,
    finishedAt: now,
    elapsed: Math.max(0, now - task.createdAt),
  })
  return true
}

function scheduleOpenAIWatchdog(taskId: string, timeoutSeconds: number) {
  clearOpenAIWatchdogTimer(taskId)
  const task = useStore.getState().tasks.find((item) => item.id === taskId)
  if (!task || !isRunningOpenAITask(task)) return

  const timeoutMs = Math.max(0, timeoutSeconds * 1000)
  const remainingMs = Math.max(0, timeoutMs - (Date.now() - task.createdAt))
  const timer = setTimeout(() => {
    openAIWatchdogTimers.delete(taskId)
    const failed = failOpenAITaskIfStillRunning(taskId, createOpenAITimeoutError(timeoutSeconds))
    if (failed) useStore.getState().showToast('OpenAI 任务请求超时', 'error')
  }, remainingMs)
  openAIWatchdogTimers.set(taskId, timer)
}

export function showCodexCliPrompt(force = false, reason = '接口返回的提示词已被改写') {
  const state = useStore.getState()
  const settings = state.settings
  const promptKey = getCodexCliPromptKey(settings)
  if (!force && (settings.codexCli || state.dismissedCodexCliPrompts.includes(promptKey))) return

  state.setConfirmDialog({
    title: '检测到 Codex CLI API',
    message: `${reason}，当前 API 来源很可能是 Codex CLI。\n\n是否开启 Codex CLI 兼容模式？开启后会禁用在此处无效的质量参数，并在 Images API 多图生成时使用并发请求，解决该 API 数量参数无效的问题。同时，提示词文本开头会加入简短的不改写要求，避免模型重写提示词，偏离原意。`,
    confirmText: '开启',
    action: () => {
      const state = useStore.getState()
      state.dismissCodexCliPrompt(promptKey)
      state.setSettings({ codexCli: true })
    },
    cancelAction: () => useStore.getState().dismissCodexCliPrompt(promptKey),
  })
}

function getFalRecoveryProfile(settings: AppSettings, task: TaskRecord) {
  const taskProfile = getTaskApiProfile(settings, task)
  if (taskProfile?.provider === 'fal') return taskProfile

  const normalized = normalizeSettings(settings)
  const active = getActiveApiProfile(normalized)
  if (active.provider === 'fal') return active
  return normalized.profiles.find((profile) =>
    profile.provider === 'fal' &&
    (profile.name === task.apiProfileName || profile.model === task.apiModel),
  ) ?? normalized.profiles.find((profile) => profile.provider === 'fal') ?? null
}

function getCustomRecoveryProfile(settings: AppSettings, task: TaskRecord) {
  const provider = task.apiProvider
  if (!provider || provider === 'openai' || provider === 'fal') return null
  const taskProfile = getTaskApiProfile(settings, task)
  if (taskProfile?.provider === provider) return taskProfile

  const normalized = normalizeSettings(settings)
  const active = getActiveApiProfile(normalized)
  if (active.provider === provider) return active
  return normalized.profiles.find((profile) =>
    profile.provider === provider &&
    (profile.name === task.apiProfileName || profile.model === task.apiModel),
  ) ?? normalized.profiles.find((profile) => profile.provider === provider) ?? null
}

export function getTaskApiProfile(settings: AppSettings, task: TaskRecord): ApiProfile | null {
  const normalized = normalizeSettings(settings)
  const provider = task.apiProvider

  if (task.apiProfileId) {
    const byId = normalized.profiles.find((profile) => profile.id === task.apiProfileId)
    if (byId && (!provider || byId.provider === provider)) return byId
    return null
  }

  if (!provider) return null


  const candidates = normalized.profiles.filter((profile) => profile.provider === provider)
  if (!candidates.length) return null

  if (task.apiProfileName) {
    const byName = candidates.find((profile) => profile.name === task.apiProfileName)
    if (byName) return byName
  }

  if (task.apiModel) {
    const modelMatches = candidates.filter((profile) => profile.model === task.apiModel)
    if (modelMatches.length === 1) return modelMatches[0]
  }

  return candidates.length === 1 ? candidates[0] : null
}

function createSettingsForApiProfile(settings: AppSettings, profile: ApiProfile): AppSettings {
  const normalized = normalizeSettings(settings)
  return normalizeSettings({
    ...normalized,
    baseUrl: profile.baseUrl,
    apiKey: profile.apiKey,
    model: profile.model,
    timeout: profile.timeout,
    apiMode: profile.apiMode,
    codexCli: profile.codexCli,
    apiProxy: profile.apiProxy,
    profiles: normalized.profiles.map((item) => item.id === profile.id ? profile : item),
    activeProfileId: profile.id,
  })
}

function getReusedTaskApiProfile(settings: AppSettings, profileId: string | null): ApiProfile | null {
  if (!profileId) return null
  return normalizeSettings(settings).profiles.find((profile) => profile.id === profileId) ?? null
}

function getTaskApiProfileName(task: TaskRecord) {
  return task.apiProfileName || task.apiModel || '未知配置'
}

function isFalConnectionRecoverableError(err: unknown) {
  if (typeof DOMException !== 'undefined' && err instanceof DOMException && err.name === 'AbortError') return true
  const message = err instanceof Error ? err.message : String(err)
  return /abort|network|failed to fetch|fetch failed|load failed|timeout|连接|断开|中断/i.test(message)
}

function isApiRequestNetworkError(err: unknown): boolean {
  if (err instanceof TypeError) {
    const message = err.message.toLowerCase()
    return /failed to fetch|fetch failed|load failed|networkerror|network request failed/i.test(message)
  }
  return false
}

function getApiRequestNetworkErrorHint(err: unknown, task: TaskRecord, settings: AppSettings): string | null {
  if (!isApiRequestNetworkError(err)) return null

  const profile = getTaskApiProfile(settings, task)
  const elapsedSeconds = Math.max(0, (Date.now() - task.createdAt) / 1000)
  const usesApiProxy = profile?.apiProxy ?? settings.apiProxy

  if (elapsedSeconds <= 15) {
    if (usesApiProxy) {
      return '提示：请求立即失败，请检查 API 代理服务是否正常运行。'
    }
    return '提示：接口可能不支持浏览器跨域请求，可开启 API 代理解决。'
  }

  if (elapsedSeconds >= 55 && elapsedSeconds <= 75) {
    return '提示：请求等待约 60 秒后被断开，这通常是 Nginx 等反向代理的默认超时，而非接口本身报错。可调大代理的超时时间（如 proxy_read_timeout），或降低图片尺寸/质量后重试。'
  }

  if (elapsedSeconds >= 110 && elapsedSeconds <= 140) {
    return '提示：请求等待约 120 秒后被断开，这通常是 Cloudflare 等 CDN/网关的超时限制，而非接口本身报错。如果使用 Cloudflare，可考虑升级套餐或使用不经过 CDN 的直连地址。'
  }

  return '提示：请求等待较长时间后被断开，通常是反向代理或网关的超时限制，而非接口本身报错。可检查代理超时设置，或降低图片尺寸/质量后重试。'
}

function getRawErrorPayload(err: unknown): Pick<Partial<TaskRecord>, 'rawImageUrls' | 'rawResponsePayload'> {
  if (!(err instanceof Error)) return {}

  const rawImageUrls = 'rawImageUrls' in err ? (err as { rawImageUrls?: unknown }).rawImageUrls : undefined
  const rawResponsePayload = 'rawResponsePayload' in err ? (err as { rawResponsePayload?: unknown }).rawResponsePayload : undefined
  return {
    rawImageUrls: Array.isArray(rawImageUrls) && rawImageUrls.length ? rawImageUrls.filter((url): url is string => typeof url === 'string') : undefined,
    rawResponsePayload: typeof rawResponsePayload === 'string' ? rawResponsePayload : undefined,
  }
}

function clearFalRecoveryTimer(taskId: string) {
  const timer = falRecoveryTimers.get(taskId)
  if (timer) clearTimeout(timer)
  falRecoveryTimers.delete(taskId)
}

function scheduleFalRecovery(taskId: string, delayMs = FAL_RECOVERY_POLL_MS) {
  if (falRecoveryTimers.has(taskId)) return
  const timer = setTimeout(() => {
    falRecoveryTimers.delete(taskId)
    recoverFalTask(taskId)
  }, delayMs)
  falRecoveryTimers.set(taskId, timer)
}

function clearCustomRecoveryTimer(taskId: string) {
  const timer = customRecoveryTimers.get(taskId)
  if (timer) clearTimeout(timer)
  customRecoveryTimers.delete(taskId)
}

function scheduleCustomRecovery(taskId: string, delayMs = CUSTOM_RECOVERY_POLL_MS) {
  if (customRecoveryTimers.has(taskId)) return
  const timer = setTimeout(() => {
    customRecoveryTimers.delete(taskId)
    recoverCustomTask(taskId)
  }, delayMs)
  customRecoveryTimers.set(taskId, timer)
}

function hasActualParams(params: Partial<TaskParams> | undefined): params is Partial<TaskParams> {
  return Boolean(params && Object.keys(params).length > 0)
}

function firstActualParams(paramsList: Array<Partial<TaskParams> | undefined> | undefined): Partial<TaskParams> | undefined {
  return paramsList?.find(hasActualParams)
}

function mapActualParamsByImage(outputIds: string[], paramsList: Array<Partial<TaskParams> | undefined> | undefined) {
  const mapped = paramsList?.reduce<Record<string, Partial<TaskParams>>>((acc, params, index) => {
    const imgId = outputIds[index]
    if (imgId && hasActualParams(params)) acc[imgId] = params
    return acc
  }, {})
  return mapped && Object.keys(mapped).length > 0 ? mapped : undefined
}

async function readImageSizeParam(dataUrl: string): Promise<Partial<TaskParams> | undefined> {
  if (typeof Image === 'undefined') return undefined

  return new Promise((resolve) => {
    let settled = false
    const image = new Image()
    const finish = (params: Partial<TaskParams> | undefined) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(params)
    }
    const timer = setTimeout(() => finish(undefined), 2000)
    image.onload = () => {
      if (image.naturalWidth > 0 && image.naturalHeight > 0) {
        finish({ size: `${image.naturalWidth}x${image.naturalHeight}` })
      } else {
        finish(undefined)
      }
    }
    image.onerror = () => finish(undefined)
    image.src = dataUrl
    if (image.complete && image.naturalWidth > 0 && image.naturalHeight > 0) {
      finish({ size: `${image.naturalWidth}x${image.naturalHeight}` })
    }
  })
}

async function readImageSizeParamsList(images: string[]): Promise<Array<Partial<TaskParams> | undefined>> {
  return Promise.all(images.map((image) => readImageSizeParam(image)))
}

async function resolveImageSizeParamsList(
  images: string[],
  preferred?: Array<Partial<TaskParams> | undefined>,
): Promise<Array<Partial<TaskParams> | undefined>> {
  if (preferred?.length === images.length && preferred.every(hasActualParams)) return preferred
  const fallback = await readImageSizeParamsList(images)
  return images.map((_, index) => hasActualParams(preferred?.[index]) ? preferred?.[index] : fallback[index])
}

async function completeRecoveredFalTask(task: TaskRecord, result: Awaited<ReturnType<typeof getFalQueuedImageResult>>) {
  const latest = useStore.getState().tasks.find((item) => item.id === task.id)
  if (!latest || latest.status === 'done') return

  const actualParamsList = await resolveImageSizeParamsList(result.images, result.actualParamsList)
  const outputIds: string[] = []
  for (const dataUrl of result.images) {
    const imgId = await storeImage(dataUrl, 'generated')
    cacheImage(imgId, dataUrl)
    outputIds.push(imgId)
  }

  updateTaskInStore(task.id, {
    outputImages: outputIds,
    actualParams: firstActualParams(actualParamsList),
    actualParamsByImage: mapActualParamsByImage(outputIds, actualParamsList),
    revisedPromptByImage: undefined,
    status: 'done',
    error: null,
    falRecoverable: false,
    finishedAt: Date.now(),
    elapsed: Date.now() - task.createdAt,
  })
  useStore.getState().showToast(`fal.ai 任务已恢复，共 ${outputIds.length} 张图片`, 'success')
}

async function recoverFalTask(taskId: string) {
  const { settings, tasks } = useStore.getState()
  const task = tasks.find((item) => item.id === taskId)
  if (!task || task.apiProvider !== 'fal' || !task.falRequestId || !task.falEndpoint || task.status === 'done') return

  const profile = getFalRecoveryProfile(settings, task)
  if (!profile) {
    scheduleFalRecovery(taskId)
    return
  }

  try {
    const result = await getFalQueuedImageResult(profile, task.falEndpoint, task.falRequestId, task.params)
    clearFalRecoveryTimer(taskId)
    await completeRecoveredFalTask(task, result)
    return
  } catch (err) {
    if (isFalConnectionRecoverableError(err)) {
      scheduleFalRecovery(taskId)
      return
    }

    clearFalRecoveryTimer(taskId)
    updateTaskInStore(taskId, {
      status: 'error',
      error: getFalErrorMessage(err) ?? (err instanceof Error ? err.message : String(err)),
      ...getRawErrorPayload(err),
      falRecoverable: false,
      finishedAt: Date.now(),
      elapsed: Date.now() - task.createdAt,
    })
  }
}

/** 初始化：从 IndexedDB 加载任务，按需恢复输入图片，并清理孤立图片 */
export async function initStore() {
  const storedTasks = await getAllTasks()
  const { tasks, interruptedTasks } = markInterruptedOpenAIRunningTasks(storedTasks)
  await Promise.all(interruptedTasks.map((task) => putTask(task)))
  useStore.getState().setTasks(tasks)
  showSupportPromptForExistingLocalData(tasks)
  for (const task of tasks) {
    if (
      task.apiProvider === 'fal' &&
      task.falRequestId &&
      task.falEndpoint &&
      (task.status === 'running' || task.falRecoverable)
    ) {
      scheduleFalRecovery(task.id, 0)
    }
    if (
      task.customTaskId &&
      (task.status === 'running' || task.customRecoverable)
    ) {
      scheduleCustomRecovery(task.id, 0)
    }
    if (
      task.backendJobId &&
      shouldExecuteBackendJob(task) &&
      (task.status === 'queued' || task.status === 'running' || task.backendRecoverable)
    ) {
      executeTask(task.id)
    }
  }

  // 收集所有任务引用的图片 id
  const referencedIds = new Set<string>()
  const persistedInputImages = useStore.getState().inputImages
  for (const img of persistedInputImages) referencedIds.add(img.id)
  for (const t of tasks) {
    for (const id of t.inputImageIds || []) referencedIds.add(id)
    if (t.maskImageId) referencedIds.add(t.maskImageId)
    for (const id of t.outputImages || []) {
      referencedIds.add(id)
    }
  }

  // 只枚举 key 清理孤立图片，避免启动时把所有 4K 原图读进内存。
  const imageIds = await getAllImageIds()
  const referencedImageIds: string[] = []
  for (const imgId of imageIds) {
    if (referencedIds.has(imgId)) {
      referencedImageIds.push(imgId)
    } else {
      await deleteImage(imgId)
    }
  }
  scheduleThumbnailBackfill(referencedImageIds)

  const restoredInputImages: InputImage[] = []
  for (const img of persistedInputImages) {
    if (img.dataUrl) {
      restoredInputImages.push(img)
      cacheImage(img.id, img.dataUrl)
      continue
    }
    const storedImage = await getImage(img.id)
    if (storedImage?.dataUrl) {
      restoredInputImages.push({ ...img, dataUrl: storedImage.dataUrl })
      cacheImage(img.id, storedImage.dataUrl)
    }
  }
  if (restoredInputImages.length !== persistedInputImages.length || restoredInputImages.some((img, index) => img.dataUrl !== persistedInputImages[index]?.dataUrl)) {
    useStore.getState().setInputImages(restoredInputImages)
  }
}

/** 提交新任务 */
export async function submitTask(options: { allowFullMask?: boolean; useCurrentApiProfileWhenReusedMissing?: boolean } = {}) {
  const { settings, prompt, inputImages, maskDraft, params, reusedTaskApiProfileId, reusedTaskApiProfileName, reusedTaskApiProfileMissing, showToast, setConfirmDialog, batchMode, batchCount, serverImageBatchMode } =
    useStore.getState()

  const normalizedSettings = normalizeSettings(settings)
  let activeProfile = getActiveApiProfile(settings)
  let requestSettings = createSettingsForApiProfile(normalizedSettings, activeProfile)
  if (normalizedSettings.reuseTaskApiProfileTemporarily && (reusedTaskApiProfileId || reusedTaskApiProfileMissing)) {
    const reusedProfile = getReusedTaskApiProfile(normalizedSettings, reusedTaskApiProfileId)
    if (!reusedProfile) {
      if (options.useCurrentApiProfileWhenReusedMissing) {
        useStore.getState().setReusedTaskApiProfile(null)
      } else {
        setConfirmDialog({
          title: '找不到 API 配置',
      message: `找不到复用任务所使用的 API 配置「${reusedTaskApiProfileName || '未知配置'}」，要使用当前的 API 配置「${activeProfile.name}」提交任务吗？`,
      confirmText: '使用当前配置提交',
      cancelText: '放弃提交',
      action: () => {
        void submitTask({ ...options, useCurrentApiProfileWhenReusedMissing: true })
      },
        })
        return
      }
    } else {
      activeProfile = reusedProfile
      requestSettings = createSettingsForApiProfile(normalizedSettings, reusedProfile)
    }
  }

  if (!prompt.trim()) {
    showToast('请输入提示词', 'error')
    return
  }
  if (batchMode && maskDraft) {
    showToast('批量模式暂不支持遮罩编辑，请关闭批量模式或移除遮罩后再提交', 'error')
    return
  }
  const serverImagePath = serverImageBatchMode ? String((settings as any).adminServerImagePath || '').trim() : ''
  if (serverImageBatchMode && !serverImagePath) {
    showToast('管理员尚未配置服务器图片目录', 'error')
    return
  }
  if (serverImageBatchMode && inputImages.length > 0) {
    showToast('服务器目录批量模式会使用服务器目录图片，请先移除本地参考图', 'error')
    return
  }

  let orderedInputImages = inputImages
  let maskImageId: string | null = null
  let maskTargetImageId: string | null = null

  if (maskDraft) {
    try {
      orderedInputImages = orderInputImagesForMask(inputImages, maskDraft.targetImageId)
      const coverage = await validateMaskMatchesImage(maskDraft.maskDataUrl, orderedInputImages[0].dataUrl)
      if (coverage === 'full' && !options.allowFullMask) {
        setConfirmDialog({
          title: '确认编辑整张图片？',
          message: '当前遮罩覆盖了整张图片，提交后可能会重绘全部内容。是否继续？',
          confirmText: '继续提交',
          tone: 'warning',
          action: () => {
            void submitTask({ allowFullMask: true })
          },
        })
        return
      }
      maskImageId = await storeImage(maskDraft.maskDataUrl, 'mask')
      cacheImage(maskImageId, maskDraft.maskDataUrl)
      maskTargetImageId = maskDraft.targetImageId
    } catch (err) {
      if (!inputImages.some((img) => img.id === maskDraft.targetImageId)) {
        useStore.getState().clearMaskDraft()
      }
      showToast(err instanceof Error ? err.message : String(err), 'error')
      return
    }
  }

  // 持久化输入图片到 IndexedDB（此前只在内存缓存中）
  for (const img of orderedInputImages) {
    await storeImage(img.dataUrl)
  }

  const normalizedParams = normalizeParamsForSettings(params, requestSettings, { hasInputImages: orderedInputImages.length > 0 || serverImageBatchMode })
  const submittedParams = (batchMode || serverImageBatchMode)
    ? { ...normalizedParams, n: 1 }
    : normalizedParams
  const normalizedParamPatch = getChangedParams(params, normalizedParams)
  if (batchMode || serverImageBatchMode) {
    delete (normalizedParamPatch as Partial<TaskParams>).n
  }
  if (Object.keys(normalizedParamPatch).length) {
    useStore.getState().setParams(normalizedParamPatch)
  }

  const isBatchTask = batchMode || serverImageBatchMode
  const submittedBatchCount = isBatchTask && !serverImageBatchMode && orderedInputImages.length === 0 ? batchCount : undefined
  const batchTotal = isBatchTask
    ? serverImageBatchMode
      ? undefined
      : orderedInputImages.length > 0
      ? orderedInputImages.length
      : batchCount
    : undefined
  const batchId = isBatchTask && batchTotal && batchTotal > 1 ? genId() : undefined
  const taskInputGroups = isBatchTask
    ? serverImageBatchMode
      ? [[] as InputImage[]]
      : orderedInputImages.length > 0
      ? orderedInputImages.map((img) => [img])
      : Array.from({ length: batchCount }, () => [] as InputImage[])
    : [orderedInputImages]
  const createdAt = Date.now()
  const tasks = taskInputGroups.map((group, index): TaskRecord => ({
    id: genId(),
    prompt: prompt.trim(),
    params: submittedParams,
    apiProvider: activeProfile.provider,
    apiProfileId: activeProfile.id,
    apiProfileName: activeProfile.name,
    apiModel: activeProfile.model,
    inputImageIds: group.map((i) => i.id),
    maskTargetImageId,
    maskImageId,
    outputImages: [],
    status: 'queued',
    error: null,
    createdAt: createdAt + index,
    finishedAt: null,
    elapsed: null,
    batch: isBatchTask,
    batchId,
    batchCount: index === 0 ? submittedBatchCount : undefined,
    batchIndex: isBatchTask && batchTotal ? index + 1 : undefined,
    batchTotal,
    serverImagePath: index === 0 && serverImageBatchMode ? serverImagePath : undefined,
    queuePosition: 0,
    backendJobOwner: isBatchTask ? index === 0 : undefined,
  }))
  const ownerTask = tasks[0]

  const latestTasks = useStore.getState().tasks
  useStore.getState().setTasks([...tasks, ...latestTasks])
  await Promise.all(tasks.map((task) => putTask(task)))

  if (settings.clearInputAfterSubmit) {
    useStore.getState().setPrompt('')
    useStore.getState().clearInputImages()
  }
  useStore.getState().setReusedTaskApiProfile(null)

  // 异步调用 API
  executeTask(ownerTask.id)
}

async function ensureServerBatchDisplayTasks(ownerTask: TaskRecord, backendJob: BackendJob): Promise<TaskRecord> {
  const total = backendJob.progress?.total
  if (!ownerTask.batch || !ownerTask.serverImagePath || !total || total <= 1) return ownerTask

  const currentTasks = useStore.getState().tasks
  const currentOwner = currentTasks.find((item) => item.id === ownerTask.id) || ownerTask
  const batchId = currentOwner.batchId || genId()
  const siblings = currentTasks
    .filter((item) => item.id === currentOwner.id || item.batchId === batchId)
    .sort((a, b) => (a.batchIndex || 0) - (b.batchIndex || 0))
  if (siblings.length >= total && currentOwner.batchTotal === total && currentOwner.batchId) return currentOwner

  const existingByIndex = new Map<number, TaskRecord>()
  for (const sibling of siblings) {
    if (sibling.batchIndex) existingByIndex.set(sibling.batchIndex, sibling)
  }
  existingByIndex.set(1, currentOwner)

  const displayTasks: TaskRecord[] = []
  for (let index = 1; index <= total; index++) {
    const existing = existingByIndex.get(index)
    displayTasks.push({
      ...(existing || currentOwner),
      id: existing?.id || genId(),
      inputImageIds: existing?.inputImageIds || [],
      outputImages: existing?.outputImages || [],
      status: existing?.status || 'running',
      error: existing?.error ?? null,
      createdAt: existing?.createdAt ?? currentOwner.createdAt + index - 1,
      finishedAt: existing?.finishedAt ?? null,
      elapsed: existing?.elapsed ?? null,
      batch: true,
      batchId,
      batchIndex: index,
      batchTotal: total,
      batchCount: index === 1 ? currentOwner.batchCount : undefined,
      serverImagePath: index === 1 ? currentOwner.serverImagePath : undefined,
      backendJobId: backendJob.id,
      backendJobOwner: index === 1,
      backendProgress: backendJob.progress || undefined,
      queuePosition: backendJob.queuePosition,
    })
  }

  const groupIds = new Set(displayTasks.map((item) => item.id))
  for (const sibling of siblings) groupIds.add(sibling.id)
  const ownerIndex = currentTasks.findIndex((item) => item.id === currentOwner.id)
  const withoutGroup = currentTasks.filter((item) => !groupIds.has(item.id))
  const insertAt = ownerIndex < 0 ? 0 : Math.min(ownerIndex, withoutGroup.length)
  const nextTasks = [
    ...withoutGroup.slice(0, insertAt),
    ...displayTasks,
    ...withoutGroup.slice(insertAt),
  ]
  useStore.getState().setTasks(nextTasks)
  await Promise.all(displayTasks.map((item) => putTask(item)))
  return displayTasks[0]
}

function updateBackendJobStateForDisplayTasks(task: TaskRecord, backendJob: BackendJob, status: TaskRecord['status']) {
  const latestTask = useStore.getState().tasks.find((item) => item.id === task.id) || task
  const targets = latestTask.backendJobOwner && latestTask.batchId ? getBatchSiblings(latestTask) : [latestTask]
  for (const target of targets) {
    const currentStatus = target.status
    const isTerminal = currentStatus === 'done' || currentStatus === 'error' || currentStatus === 'cancelled'
    updateTaskInStore(target.id, {
      backendJobId: backendJob.id,
      ...(isTerminal ? {} : { status }),
      queuePosition: backendJob.queuePosition,
      backendProgress: backendJob.progress || undefined,
      backendRecoverable: false,
    })
  }
}

async function executeTask(taskId: string) {
  const task = useStore.getState().tasks.find((t) => t.id === taskId)
  if (!task) return
  if (!shouldExecuteBackendJob(task)) return

  let syncRecoverableBackendJobId: string | null = null
  try {
    let maskDataUrl: string | undefined
    let backendJob: BackendJob
    if (task.backendJobId) {
      try {
        backendJob = (await getBackendJob(task.backendJobId)).job
      } catch (err) {
        if (isBackendJobPollRecoverableError(err)) {
          setTimeout(() => executeTask(taskId), BACKEND_JOB_POLL_RETRY_MS)
          return
        }
        throw err
      }
      const displayOwner = await ensureServerBatchDisplayTasks(task, backendJob)
      updateBackendJobStateForDisplayTasks(
        displayOwner,
        backendJob,
        backendJob.status === 'queued'
          ? 'queued'
          : backendJob.status === 'running' || (task.backendRecoverable && backendJob.status === 'done')
          ? 'running'
          : task.status,
      )
    } else {
      const displayTasks = task.backendJobOwner && task.batchId ? getBatchSiblings(task) : [task]
      const requestInputImageIds = task.backendJobOwner && task.batchId && !task.serverImagePath
        ? displayTasks.flatMap((item) => item.inputImageIds)
        : task.inputImageIds
      const inputDataUrls: string[] = []
      const inputImageUploadIds: string[] = []
      for (const imgId of requestInputImageIds) {
        const dataUrl = await ensureImageCached(imgId)
        if (!dataUrl) throw new Error('输入图片已不存在')
        if (task.batch && task.backendJobOwner && !task.serverImagePath) {
          const uploaded = await uploadBackendInputImage(dataUrl)
          inputImageUploadIds.push(uploaded.upload.id)
        } else {
          inputDataUrls.push(dataUrl)
        }
      }
      if (task.maskImageId) {
        maskDataUrl = await ensureImageCached(task.maskImageId)
        if (!maskDataUrl) throw new Error('遮罩图片已不存在')
      }

      const created = await createBackendJob({
        prompt: replaceImageMentionsForApi(task.prompt, requestInputImageIds.length),
        params: task.params,
        inputImageDataUrls: inputDataUrls,
        inputImageUploadIds: inputImageUploadIds.length ? inputImageUploadIds : undefined,
        maskDataUrl,
        batch: Boolean(task.batch),
        batchCount: task.batch && inputDataUrls.length === 0 && inputImageUploadIds.length === 0 ? task.batchCount || displayTasks.length : task.batchCount,
        serverImagePath: task.serverImagePath,
      })

      const latestAfterCreate = useStore.getState().tasks.find((t) => t.id === taskId)
      if (!latestAfterCreate || latestAfterCreate.status === 'cancelled') {
        await cancelBackendJob(created.job.id).catch(() => {})
        return
      }

      updateBackendJobStateForDisplayTasks(task, created.job, created.job.status === 'queued' ? 'queued' : 'running')

      backendJob = created.job
    }
    const appliedRecordIds = new Set<string>()
    const appliedFailedIndexes = new Set<number>()
    while (backendJob.status === 'queued' || backendJob.status === 'running') {
      await sleep(1200)
      const latest = useStore.getState().tasks.find((t) => t.id === taskId)
      if (!latest || latest.status === 'cancelled') return
      let polled
      try {
        polled = await getBackendJob(backendJob.id)
      } catch (err) {
        if (isBackendJobPollRecoverableError(err)) {
          await sleep(BACKEND_JOB_POLL_RETRY_MS)
          continue
        }
        throw err
      }
      backendJob = polled.job
      const displayOwner = await ensureServerBatchDisplayTasks(latest, backendJob)
      updateBackendJobStateForDisplayTasks(displayOwner, backendJob, backendJob.status === 'queued' ? 'queued' : backendJob.status === 'running' ? 'running' : latest.status)

      // Apply partial results from completedRecords in real-time
      if (backendJob.progress?.completedRecords?.length && displayOwner.batchId) {
        const siblings = getBatchSiblings(displayOwner)
        for (const record of backendJob.progress.completedRecords) {
          if (appliedRecordIds.has(record.id)) continue
          appliedRecordIds.add(record.id)
          const sibling = siblings.find((s) => s.batchIndex === record.requestIndex)
          if (sibling && sibling.status !== 'done' && sibling.status !== 'cancelled') {
            try {
              const imgRes = await fetch(record.outputUrl, { credentials: 'include' })
              if (imgRes.ok) {
                const blob = await imgRes.blob()
                const reader = new FileReader()
                const dataUrl = await new Promise<string>((resolve) => {
                  reader.onload = () => resolve(reader.result as string)
                  reader.readAsDataURL(blob)
                })
                const imgId = await storeImage(dataUrl, 'generated')
                cacheImage(imgId, dataUrl)
                updateTaskInStore(sibling.id, {
                  outputImages: [imgId],
                  status: 'done',
                  error: null,
                  finishedAt: Date.now(),
                  elapsed: Date.now() - sibling.createdAt,
                  backendRecoverable: false,
                  backendProgress: undefined,
                })
              }
            } catch {
              // Will be handled when job completes
            }
          }
        }
      }

      // Apply partial failures from failedRequests in real-time
      if (backendJob.progress?.failedRequests?.length && displayOwner.batchId) {
        const siblings = getBatchSiblings(displayOwner)
        for (const failure of backendJob.progress.failedRequests) {
          if (appliedFailedIndexes.has(failure.requestIndex)) continue
          appliedFailedIndexes.add(failure.requestIndex)
          const sibling = siblings.find((s) => s.batchIndex === failure.requestIndex)
          if (sibling && sibling.status !== 'done' && sibling.status !== 'error' && sibling.status !== 'cancelled') {
            updateTaskInStore(sibling.id, {
              status: 'error',
              error: failure.message,
              finishedAt: Date.now(),
              elapsed: Date.now() - sibling.createdAt,
              backendRecoverable: false,
              backendProgress: undefined,
            })
          }
        }
      }
    }

    if (backendJob.status === 'cancelled') {
      const latestCancelledTask = useStore.getState().tasks.find((item) => item.id === taskId) || task
      const targets = latestCancelledTask.backendJobOwner && latestCancelledTask.batchId ? getBatchSiblings(latestCancelledTask) : [latestCancelledTask]
      for (const target of targets) {
        if (target.status === 'done' || target.status === 'error') {
          continue
        }
        updateTaskInStore(target.id, {
          status: 'cancelled',
          error: backendJob.error || '请求已取消',
          finishedAt: backendJob.finishedAt ?? Date.now(),
          elapsed: Date.now() - target.createdAt,
          backendProgress: backendJob.progress || undefined,
          backendRecoverable: false,
        })
      }
      return
    }

    if (backendJob.status === 'error' || !backendJob.result) {
      throw new Error(backendJob.error || '后端任务失败')
    }

    const result = backendJob.result

    syncRecoverableBackendJobId = backendJob.id

    // Compile mapping of sibling request index -> existing imageIds to avoid re-fetching
    const currentTaskState = useStore.getState().tasks.find((item) => item.id === taskId) || task
    const existingByRequestIndex = new Map<number, string[]>()
    if (currentTaskState.backendJobOwner && currentTaskState.batchId) {
      const siblings = getBatchSiblings(currentTaskState)
      for (const sibling of siblings) {
        if (
          sibling.status === 'done' &&
          sibling.outputImages?.length &&
          sibling.batchIndex &&
          !sibling.hiddenByRetry
        ) {
          existingByRequestIndex.set(sibling.batchIndex, sibling.outputImages)
        }
      }
    }

    const resultOutputs = await getBackendResultOutputs(result, existingByRequestIndex)
    if (resultOutputs.length === 0) {
      throw new Error('后端任务未返回图片')
    }
    const storedOutputs: Array<{
      imageId: string
      requestIndex: number
      actualParams?: Partial<TaskParams>
      revisedPrompt?: string
      rawImageUrl?: string
    }> = []
    for (const output of resultOutputs) {
      if (output.imageId) {
        storedOutputs.push({
          imageId: output.imageId,
          requestIndex: output.requestIndex,
          actualParams: output.actualParams,
          revisedPrompt: output.revisedPrompt,
          rawImageUrl: output.rawImageUrl,
        })
      } else if (output.dataUrl) {
        const imgId = await storeImage(output.dataUrl, 'generated')
        cacheImage(imgId, output.dataUrl)
        storedOutputs.push({
          imageId: imgId,
          requestIndex: output.requestIndex,
          actualParams: output.actualParams,
          revisedPrompt: output.revisedPrompt,
          rawImageUrl: output.rawImageUrl,
        })
      }
    }

    const latestBeforeUpdate = useStore.getState().tasks.find((t) => t.id === taskId)
    if (!latestBeforeUpdate || (latestBeforeUpdate.status !== 'running' && latestBeforeUpdate.status !== 'queued' && !latestBeforeUpdate.backendRecoverable)) return
    syncRecoverableBackendJobId = null
    if (latestBeforeUpdate.backendJobOwner && latestBeforeUpdate.batchId) {
      const siblings = getBatchSiblings(latestBeforeUpdate)
      const errorsByIndex = new Map((result.requestErrors || []).map((item) => [item.requestIndex, item]))
      const skippedByIndex = new Map((result.skippedRequests || []).map((item) => [item.requestIndex, item]))
      for (const sibling of siblings) {
        if (sibling.status === 'cancelled') continue
        if (sibling.status === 'done' && sibling.outputImages?.length && !sibling.hiddenByRetry) continue

        const requestIndex = sibling.batchIndex || 1
        const outputsForTask = storedOutputs.filter((item) => item.requestIndex === requestIndex)
        const outputIds = outputsForTask.map((item) => item.imageId)
        const requestError = errorsByIndex.get(requestIndex)
        const requestSkipped = skippedByIndex.get(requestIndex)
        if (outputIds.length > 0) {
          const actualParamsList = outputsForTask.map((item) => item.actualParams)
          const actualParams = { ...(outputsForTask[0]?.actualParams || result.actualParams), n: outputIds.length }
          const actualParamsByImage = mapActualParamsByImage(outputIds, actualParamsList)
          const revisedPromptByImage = outputsForTask.reduce<Record<string, string>>((acc, output, index) => {
            const imgId = outputIds[index]
            if (imgId && output.revisedPrompt?.trim()) acc[imgId] = output.revisedPrompt
            return acc
          }, {})
          const rawImageUrls = outputsForTask.map((item) => item.rawImageUrl).filter((url): url is string => Boolean(url))
          updateTaskInStore(sibling.id, {
            outputImages: outputIds,
            rawImageUrls: rawImageUrls.length ? rawImageUrls : undefined,
            actualParams,
            actualParamsByImage,
            revisedPromptByImage: Object.keys(revisedPromptByImage).length > 0 ? revisedPromptByImage : undefined,
            partialFailure: undefined,
            failedCount: undefined,
            requestErrors: undefined,
            status: 'done',
            error: null,
            finishedAt: backendJob.finishedAt ?? Date.now(),
            elapsed: (backendJob.finishedAt ?? Date.now()) - sibling.createdAt,
            falRecoverable: false,
            customRecoverable: false,
            backendRecoverable: false,
            backendProgress: undefined,
            queuePosition: 0,
          })
        } else if (requestError) {
          updateTaskInStore(sibling.id, {
            status: 'error',
            error: requestError.message,
            requestErrors: [requestError],
            failedCount: 1,
            finishedAt: backendJob.finishedAt ?? Date.now(),
            elapsed: (backendJob.finishedAt ?? Date.now()) - sibling.createdAt,
            falRecoverable: false,
            customRecoverable: false,
            backendRecoverable: false,
            backendProgress: undefined,
            queuePosition: 0,
          })
        } else if (requestSkipped) {
          updateTaskInStore(sibling.id, {
            status: 'cancelled',
            error: '请求已取消',
            finishedAt: backendJob.finishedAt ?? Date.now(),
            elapsed: (backendJob.finishedAt ?? Date.now()) - sibling.createdAt,
            falRecoverable: false,
            customRecoverable: false,
            backendRecoverable: false,
            backendProgress: undefined,
            queuePosition: 0,
          })
        }
      }
      if (!maybeShowBatchCompletionToast(latestBeforeUpdate)) {
        useStore.getState().showToast(`批量任务完成 ${storedOutputs.length}/${siblings.length}`, result.partialFailure ? 'success' : 'success')
      }
      return
    }

    const outputIds = storedOutputs.map((item) => item.imageId)
    const actualParamsList = storedOutputs.map((item) => item.actualParams)
    const actualParams = { ...(storedOutputs[0]?.actualParams || result.actualParams), n: outputIds.length }
    const actualParamsByImage = mapActualParamsByImage(outputIds, actualParamsList)
    const revisedPromptByImage = storedOutputs.reduce<Record<string, string>>((acc, output, index) => {
      const imgId = outputIds[index]
      if (imgId && output.revisedPrompt?.trim()) acc[imgId] = output.revisedPrompt
      return acc
    }, {})
    const rawImageUrls = storedOutputs.map((item) => item.rawImageUrl).filter((url): url is string => Boolean(url))
    updateTaskInStore(taskId, {
      outputImages: outputIds,
      rawImageUrls: rawImageUrls.length ? rawImageUrls : undefined,
      actualParams,
      actualParamsByImage,
      revisedPromptByImage: Object.keys(revisedPromptByImage).length > 0 ? revisedPromptByImage : undefined,
      partialFailure: result.partialFailure || undefined,
      failedCount: result.failedCount || undefined,
      requestErrors: result.requestErrors?.length ? result.requestErrors : undefined,
      status: 'done',
      finishedAt: backendJob.finishedAt ?? Date.now(),
      elapsed: (backendJob.finishedAt ?? Date.now()) - task.createdAt,
      falRecoverable: false,
      customRecoverable: false,
      backendRecoverable: false,
      backendProgress: undefined,
      queuePosition: 0,
    })
    if (!maybeShowBatchCompletionToast(task)) {
      if (result.partialFailure && (result.failedCount || result.requestErrors?.length)) {
        useStore.getState().showToast(`部分完成：成功 ${outputIds.length}，失败 ${result.failedCount || result.requestErrors?.length || 0}`, 'success')
      } else {
        useStore.getState().showToast(`生成完成，共 ${outputIds.length} 张图片`, 'success')
      }
    }
    const currentMask = useStore.getState().maskDraft
    if (
      maskDataUrl &&
      currentMask &&
      currentMask.targetImageId === task.maskTargetImageId &&
      currentMask.maskDataUrl === maskDataUrl
    ) {
      useStore.getState().clearMaskDraft()
    }
  } catch (err) {
    const latestTask = useStore.getState().tasks.find((t) => t.id === taskId) ?? task
    if (latestTask.status !== 'running' && latestTask.status !== 'queued' && !latestTask.backendRecoverable) return
    const canResyncBackendJob = Boolean(syncRecoverableBackendJobId)
    const targets = latestTask.backendJobOwner && latestTask.batchId ? getBatchSiblings(latestTask) : [latestTask]
    for (const target of targets) {
      updateTaskInStore(target.id, {
        status: 'error',
        error: canResyncBackendJob
          ? `后端任务已完成，但同步结果失败：${err instanceof Error ? err.message : String(err)}`
          : err instanceof Error ? err.message : String(err),
        ...getRawErrorPayload(err),
        falRecoverable: false,
        customRecoverable: false,
        backendJobId: syncRecoverableBackendJobId || target.backendJobId || latestTask.backendJobId,
        backendRecoverable: canResyncBackendJob,
        finishedAt: Date.now(),
        elapsed: Date.now() - target.createdAt,
      })
    }
    if (!maybeShowBatchCompletionToast(task)) {
      useStore.getState().setDetailTaskId(taskId)
    }
  } finally {
    // 释放输入图片的内存缓存（已持久化到 IndexedDB，后续按需从 DB 加载）
    for (const imgId of task.inputImageIds) {
      imageCache.delete(imgId)
    }
  }
}

export function updateTaskInStore(taskId: string, patch: Partial<TaskRecord>) {
  const { tasks, setTasks } = useStore.getState()
  const updated = tasks.map((t) =>
    t.id === taskId ? { ...t, ...patch } : t,
  )
  setTasks(updated)
  maybeOpenSupportPrompt(tasks, updated, taskId)
  const task = updated.find((t) => t.id === taskId)
  if (task) putTask(task)
}

export async function cancelQueuedTask(task: TaskRecord) {
  if (task.status !== 'queued') return
  try {
    const owner = getBackendJobOwner(task)
    const targets = owner.backendJobOwner && owner.batchId ? getBatchSiblings(owner) : [task]
    const backendJobId = owner.backendJobId || task.backendJobId
    if (backendJobId) await cancelBackendJob(backendJobId)
    for (const target of targets) {
      updateTaskInStore(target.id, {
        status: 'cancelled',
        error: '请求已取消',
        finishedAt: Date.now(),
        elapsed: Date.now() - target.createdAt,
        queuePosition: 0,
        backendProgress: undefined,
        backendRecoverable: false,
      })
    }
    maybeShowBatchCompletionToast({ ...task, status: 'cancelled' })
  } catch (err) {
    useStore.getState().showToast(err instanceof Error ? err.message : String(err), 'error')
  }
}

/** 重试失败的任务：创建新任务并执行 */
export async function retryTask(task: TaskRecord) {
  const backendOwner = getBackendJobOwner(task)
  const recoverableJobId = task.backendRecoverable && (backendOwner.backendJobId || task.backendJobId)
  if (recoverableJobId) {
    const targets = backendOwner.backendJobOwner && backendOwner.batchId ? getBatchSiblings(backendOwner) : [task]
    for (const target of targets) updateTaskInStore(target.id, {
      status: 'running',
      error: null,
      backendJobId: recoverableJobId,
      backendRecoverable: false,
      finishedAt: null,
      elapsed: null,
      queuePosition: 0,
    })
    executeTask(backendOwner.id)
    return
  }

  const { settings } = useStore.getState()
  const activeProfile = getActiveApiProfile(settings)
  const normalizedParams = normalizeParamsForSettings(task.params, settings, { hasInputImages: task.inputImageIds.length > 0 })
  const taskId = genId()
  const newTask: TaskRecord = {
    id: taskId,
    prompt: task.prompt,
    params: normalizedParams,
    apiProvider: activeProfile.provider,
    apiProfileId: activeProfile.id,
    apiProfileName: activeProfile.name,
    apiModel: activeProfile.model,
    inputImageIds: [...task.inputImageIds],
    maskTargetImageId: task.maskTargetImageId ?? null,
    maskImageId: task.maskImageId ?? null,
    outputImages: [],
    status: 'queued',
    error: null,
    createdAt: Date.now(),
    finishedAt: null,
    elapsed: null,
    batch: false,
    batchId: undefined,
    batchCount: undefined,
    batchIndex: undefined,
    batchTotal: undefined,
    serverImagePath: undefined,
    queuePosition: 0,
    backendProgress: undefined,
    backendRecoverable: false,
  }

  const latestTasks = useStore.getState().tasks
  useStore.getState().setTasks([newTask, ...latestTasks])
  await putTask(newTask)

  executeTask(taskId)
}

/** 重试批次内单个失败任务：创建新任务，隐藏原任务（可展开查看） */
export async function retryBatchItem(task: TaskRecord) {
  const { settings } = useStore.getState()
  const activeProfile = getActiveApiProfile(settings)
  const normalizedParams = normalizeParamsForSettings(task.params, settings, { hasInputImages: task.inputImageIds.length > 0 })
  const taskId = genId()
  const newTask: TaskRecord = {
    id: taskId,
    prompt: task.prompt,
    params: normalizedParams,
    apiProvider: activeProfile.provider,
    apiProfileId: activeProfile.id,
    apiProfileName: activeProfile.name,
    apiModel: activeProfile.model,
    inputImageIds: [...task.inputImageIds],
    maskTargetImageId: task.maskTargetImageId ?? null,
    maskImageId: task.maskImageId ?? null,
    outputImages: [],
    status: 'queued',
    error: null,
    createdAt: Date.now(),
    finishedAt: null,
    elapsed: null,
    // Keep in same batch for visual grouping
    batch: true,
    batchId: task.batchId,
    batchCount: undefined,
    batchIndex: task.batchIndex,
    batchTotal: task.batchTotal,
    serverImagePath: task.serverImagePath,
    queuePosition: 0,
    backendProgress: undefined,
    backendRecoverable: false,
  }

  // Hide the original failed task and link to replacement
  updateTaskInStore(task.id, {
    hiddenByRetry: true,
    retryReplacementId: taskId,
  })

  const latestTasks = useStore.getState().tasks
  useStore.getState().setTasks([newTask, ...latestTasks])
  await putTask(newTask)

  executeTask(taskId)
}

/** 跳过批量 job 中未开始的 sub-request（个别取消） */
export async function skipBatchSubRequest(batchOwnerTask: TaskRecord, requestIndex: number) {
  const backendJobId = batchOwnerTask.backendJobId
  if (!backendJobId) return
  try {
    await patchBackendJob(backendJobId, { skipIndexes: [requestIndex] })
    // Find the sibling task for this request index and mark it cancelled
    const siblings = getBatchSiblings(batchOwnerTask)
    const sibling = siblings.find((t) => t.batchIndex === requestIndex)
    if (sibling && sibling.status !== 'done') {
      updateTaskInStore(sibling.id, {
        status: 'cancelled',
        error: '已取消',
        finishedAt: Date.now(),
        elapsed: Date.now() - sibling.createdAt,
      })
    }
    useStore.getState().showToast('已取消该子任务', 'success')
  } catch (err) {
    useStore.getState().showToast(err instanceof Error ? err.message : String(err), 'error')
  }
}

/** 复用配置 */
export async function reuseConfig(task: TaskRecord) {
  const { settings, setPrompt, setParams, setInputImages, setMaskDraft, clearMaskDraft, showToast, setConfirmDialog, setReusedTaskApiProfile } = useStore.getState()
  const normalizedSettings = normalizeSettings(settings)
  const currentProfile = getActiveApiProfile(settings)
  const matchedProfile = normalizedSettings.reuseTaskApiProfileTemporarily ? getTaskApiProfile(normalizedSettings, task) : null
  const shouldTemporarilyReuseProfile = Boolean(matchedProfile && matchedProfile.id !== currentProfile.id)
  const missingReusedProfile = normalizedSettings.reuseTaskApiProfileTemporarily && !matchedProfile
  const taskProfileName = matchedProfile?.name ?? getTaskApiProfileName(task)
  const paramsSettings = shouldTemporarilyReuseProfile && matchedProfile ? createSettingsForApiProfile(normalizedSettings, matchedProfile) : normalizedSettings

  setParams(normalizeParamsForSettings(task.params, paramsSettings, { hasInputImages: task.inputImageIds.length > 0 }))
  setReusedTaskApiProfile(
    shouldTemporarilyReuseProfile && matchedProfile ? matchedProfile.id : null,
    missingReusedProfile,
    taskProfileName,
  )
  clearMaskDraft()

  // 恢复输入图片
  const imgs: InputImage[] = []
  for (const imgId of task.inputImageIds) {
    const dataUrl = await ensureImageCached(imgId)
    if (dataUrl) {
      imgs.push({ id: imgId, dataUrl })
    }
  }
  setInputImages(imgs)
  setPrompt(task.prompt)
  const maskTargetImageId = task.maskTargetImageId ?? (task.maskImageId ? task.inputImageIds[0] : null)
  if (maskTargetImageId && task.maskImageId && imgs.some((img) => img.id === maskTargetImageId)) {
    const maskDataUrl = await ensureImageCached(task.maskImageId)
    if (maskDataUrl) {
      setMaskDraft({
        targetImageId: maskTargetImageId,
        maskDataUrl,
        updatedAt: Date.now(),
      })
    } else {
      clearMaskDraft()
    }
  } else {
    clearMaskDraft()
  }
  if (missingReusedProfile) {
    setConfirmDialog({
      title: '找不到 API 配置',
      message: `找不到复用任务所使用的 API 配置「${taskProfileName}」，要使用当前的 API 配置「${currentProfile.name}」提交任务吗？`,
      confirmText: '使用当前配置提交',
      cancelText: '放弃提交',
      action: () => {
        void submitTask({ useCurrentApiProfileWhenReusedMissing: true })
      },
    })
    return
  }

  showToast(
    shouldTemporarilyReuseProfile && matchedProfile
      ? `已临时复用该任务的 API 配置「${matchedProfile.name}」`
      : '已复用配置到输入框',
    'success',
  )
}

/** 编辑输出：将输出图加入输入 */
export async function editOutputs(task: TaskRecord) {
  const { inputImages, addInputImage, showToast } = useStore.getState()
  if (!task.outputImages?.length) return

  let added = 0
  for (const imgId of task.outputImages) {
    if (inputImages.find((i) => i.id === imgId)) continue
    const dataUrl = await ensureImageCached(imgId)
    if (dataUrl) {
      addInputImage({ id: imgId, dataUrl })
      added++
    }
  }
  showToast(`已添加 ${added} 张输出图到输入`, 'success')
}

/** 删除多条任务 */
export async function removeMultipleTasks(taskIds: string[]) {
  const { tasks, setTasks, inputImages, showToast, clearSelection, selectedTaskIds } = useStore.getState()
  
  if (!taskIds.length) return

  const toDelete = new Set(taskIds)
  const remaining = tasks.filter(t => !toDelete.has(t.id))

  // 收集所有被删除任务的关联图片
  const deletedImageIds = new Set<string>()
  for (const t of tasks) {
    if (toDelete.has(t.id)) {
      for (const id of t.inputImageIds || []) deletedImageIds.add(id)
      if (t.maskImageId) deletedImageIds.add(t.maskImageId)
      for (const id of t.outputImages || []) deletedImageIds.add(id)
    }
  }

  setTasks(remaining)
  for (const id of taskIds) {
    await dbDeleteTask(id)
  }

  // 找出其他任务仍引用的图片
  const stillUsed = new Set<string>()
  for (const t of remaining) {
    for (const id of t.inputImageIds || []) stillUsed.add(id)
    if (t.maskImageId) stillUsed.add(t.maskImageId)
    for (const id of t.outputImages || []) stillUsed.add(id)
  }
  for (const img of inputImages) stillUsed.add(img.id)

  // 删除孤立图片
  for (const imgId of deletedImageIds) {
    if (!stillUsed.has(imgId)) {
      await deleteImage(imgId)
      imageCache.delete(imgId)
      thumbnailCache.delete(imgId)
    }
  }

  // 如果删除的任务在选中列表中，则移除
  const newSelection = selectedTaskIds.filter(id => !toDelete.has(id))
  if (newSelection.length !== selectedTaskIds.length) {
    useStore.getState().setSelectedTaskIds(newSelection)
  }

  showToast(`已删除 ${taskIds.length} 条记录`, 'success')
}

/** 删除单条任务 */
export async function removeTask(task: TaskRecord) {
  const { tasks, setTasks, inputImages, showToast } = useStore.getState()

  // 收集此任务关联的图片
  const taskImageIds = new Set([
    ...(task.inputImageIds || []),
    ...(task.maskImageId ? [task.maskImageId] : []),
    ...(task.outputImages || []),
  ])

  // 从列表移除
  const remaining = tasks.filter((t) => t.id !== task.id)
  setTasks(remaining)
  await dbDeleteTask(task.id)

  // 找出其他任务仍引用的图片
  const stillUsed = new Set<string>()
  for (const t of remaining) {
    for (const id of t.inputImageIds || []) stillUsed.add(id)
    if (t.maskImageId) stillUsed.add(t.maskImageId)
    for (const id of t.outputImages || []) stillUsed.add(id)
  }
  for (const img of inputImages) stillUsed.add(img.id)

  // 删除孤立图片
  for (const imgId of taskImageIds) {
    if (!stillUsed.has(imgId)) {
      await deleteImage(imgId)
      imageCache.delete(imgId)
      thumbnailCache.delete(imgId)
    }
  }

  showToast('记录已删除', 'success')
}

/** 清空数据选项 */
export interface ClearOptions {
  clearConfig?: boolean
  clearTasks?: boolean
}

/** 清空数据 */
export async function clearData(options: ClearOptions = { clearConfig: true, clearTasks: true }) {
  const { setTasks, clearInputImages, clearMaskDraft, setSettings, setParams, showToast } = useStore.getState()

  if (options.clearTasks) {
    await dbClearTasks()
    await clearImages()
    imageCache.clear()
    thumbnailCache.clear()
    thumbnailBackfillIds.clear()
    setTasks([])
    useStore.setState({ supportPromptOpen: false, supportPromptSkippedForImportedData: false })
    clearInputImages()
    clearMaskDraft()
  }

  if (options.clearConfig) {
    useStore.setState({ dismissedCodexCliPrompts: [], supportPromptDismissed: false })
    setSettings({ ...DEFAULT_SETTINGS })
    setParams({ ...DEFAULT_PARAMS })
  }

  showToast('所选数据已清空', 'success')
}

/** 从 dataUrl 解析出 MIME 扩展名和二进制数据 */
function dataUrlToBytes(dataUrl: string): { ext: string; bytes: Uint8Array } {
  const match = dataUrl.match(/^data:image\/(\w+);base64,/)
  const ext = match?.[1] ?? 'png'
  const b64 = dataUrl.replace(/^data:[^;]+;base64,/, '')
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return { ext, bytes }
}

/** 将二进制数据还原为 dataUrl */
function bytesToDataUrl(bytes: Uint8Array, filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? 'png'
  const mimeMap: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' }
  const mime = mimeMap[ext] ?? 'image/png'
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
  return `data:${mime};base64,${btoa(binary)}`
}

async function completeRecoveredCustomTask(task: TaskRecord, result: Awaited<ReturnType<typeof getCustomQueuedImageResult>>) {
  const latest = useStore.getState().tasks.find((item) => item.id === task.id)
  if (!latest || latest.status === 'done') return

  const actualParamsList = await readImageSizeParamsList(result.images)
  const outputIds: string[] = []
  for (const dataUrl of result.images) {
    const imgId = await storeImage(dataUrl, 'generated')
    cacheImage(imgId, dataUrl)
    outputIds.push(imgId)
  }

  updateTaskInStore(task.id, {
    outputImages: outputIds,
    actualParams: firstActualParams(actualParamsList),
    actualParamsByImage: mapActualParamsByImage(outputIds, actualParamsList),
    revisedPromptByImage: undefined,
    status: 'done',
    error: null,
    customRecoverable: false,
    finishedAt: Date.now(),
    elapsed: Date.now() - task.createdAt,
  })
  useStore.getState().showToast(`自定义异步任务已恢复，共 ${outputIds.length} 张图片`, 'success')
}

async function recoverCustomTask(taskId: string) {
  const { settings, tasks } = useStore.getState()
  const task = tasks.find((item) => item.id === taskId)
  if (!task || !task.customTaskId || task.status === 'done') return

  const profile = getCustomRecoveryProfile(settings, task)
  const customProvider = task.apiProvider ? getCustomProviderDefinition(settings, task.apiProvider) : null
  if (!profile || !customProvider?.poll) {
    scheduleCustomRecovery(taskId)
    return
  }

  try {
    const result = await getCustomQueuedImageResult(profile, customProvider, task.customTaskId, task.params)
    clearCustomRecoveryTimer(taskId)
    await completeRecoveredCustomTask(task, result)
  } catch (err) {
    clearCustomRecoveryTimer(taskId)
    updateTaskInStore(taskId, {
      status: 'error',
      error: err instanceof Error ? err.message : String(err),
      ...getRawErrorPayload(err),
      customRecoverable: false,
      finishedAt: Date.now(),
      elapsed: Date.now() - task.createdAt,
    })
  }
}

function formatExportFileTime(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`
}

/** 导出选项 */
export interface ExportOptions {
  exportConfig?: boolean
  exportTasks?: boolean
}

/** 导出数据为 ZIP */
export async function exportData(options: ExportOptions = { exportConfig: true, exportTasks: true }) {
  try {
    const tasks = options.exportTasks ? await getAllTasks() : []
    const images = options.exportTasks ? await getAllImages() : []
    const { settings } = useStore.getState()
    const exportedAt = Date.now()
    const imageCreatedAtFallback = new Map<string, number>()

    if (options.exportTasks) {
      for (const task of tasks) {
        for (const id of [
          ...(task.inputImageIds || []),
          ...(task.maskImageId ? [task.maskImageId] : []),
          ...(task.outputImages || []),
        ]) {
          const prev = imageCreatedAtFallback.get(id)
          if (prev == null || task.createdAt < prev) {
            imageCreatedAtFallback.set(id, task.createdAt)
          }
        }
      }
    }

    const imageFiles: ExportData['imageFiles'] = {}
    const thumbnailFiles: NonNullable<ExportData['thumbnailFiles']> = {}
    const zipFiles: Record<string, Uint8Array | [Uint8Array, { mtime: Date }]> = {}

    if (options.exportTasks) {
      for (const img of images) {
        const { ext, bytes } = dataUrlToBytes(img.dataUrl)
        const path = `images/${img.id}.${ext}`
        const createdAt = img.createdAt ?? imageCreatedAtFallback.get(img.id) ?? exportedAt
        imageFiles[img.id] = {
          path,
          createdAt,
          source: img.source,
          width: img.width,
          height: img.height,
        }
        zipFiles[path] = [bytes, { mtime: new Date(createdAt) }]

        const thumbnail = await getImageThumbnail(img.id)
        if (thumbnail?.thumbnailDataUrl) {
          const { ext: thumbnailExt, bytes: thumbnailBytes } = dataUrlToBytes(thumbnail.thumbnailDataUrl)
          const thumbnailPath = `thumbnails/${img.id}.${thumbnailExt}`
          imageFiles[img.id].width = imageFiles[img.id].width ?? thumbnail.width
          imageFiles[img.id].height = imageFiles[img.id].height ?? thumbnail.height
          thumbnailFiles[img.id] = {
            path: thumbnailPath,
            width: thumbnail.width,
            height: thumbnail.height,
            thumbnailVersion: thumbnail.thumbnailVersion,
          }
          zipFiles[thumbnailPath] = [thumbnailBytes, { mtime: new Date(createdAt) }]
          cacheThumbnail(img.id, {
            dataUrl: thumbnail.thumbnailDataUrl,
            width: thumbnail.width,
            height: thumbnail.height,
            thumbnailVersion: thumbnail.thumbnailVersion,
          })
        }
      }
    }

    const manifest: ExportData = {
      version: 3,
      exportedAt: new Date(exportedAt).toISOString(),
    }

    if (options.exportConfig) manifest.settings = settings
    if (options.exportTasks) {
      manifest.tasks = tasks
      manifest.imageFiles = imageFiles
      manifest.thumbnailFiles = thumbnailFiles
    }

    zipFiles['manifest.json'] = [strToU8(JSON.stringify(manifest, null, 2)), { mtime: new Date(exportedAt) }]

    const zipped = zipSync(zipFiles, { level: 6 })
    const blob = new Blob([zipped.buffer as ArrayBuffer], { type: 'application/zip' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `gpt-image-playground-${formatExportFileTime(new Date(exportedAt))}.zip`
    a.click()
    URL.revokeObjectURL(url)
    useStore.getState().showToast('数据已导出', 'success')
  } catch (e) {
    useStore
      .getState()
      .showToast(
        `导出失败：${e instanceof Error ? e.message : String(e)}`,
        'error',
      )
  }
}

/** 导入选项 */
export interface ImportOptions {
  importConfig?: boolean
  importTasks?: boolean
}

/** 导入 ZIP 数据 */
export async function importData(file: File, options: ImportOptions = { importConfig: true, importTasks: true }): Promise<boolean> {
  try {
    const buffer = await file.arrayBuffer()
    const unzipped = unzipSync(new Uint8Array(buffer))

    const manifestBytes = unzipped['manifest.json']
    if (!manifestBytes) throw new Error('ZIP 中缺少 manifest.json')

    const data: ExportData = JSON.parse(strFromU8(manifestBytes))

    const importedImageIds: string[] = []
    if (options.importTasks && data.tasks && data.imageFiles) {
      // 还原图片
      for (const [id, info] of Object.entries(data.imageFiles)) {
        const bytes = unzipped[info.path]
        if (!bytes) continue
        const dataUrl = bytesToDataUrl(bytes, info.path)
        await putImage({
          id,
          dataUrl,
          createdAt: info.createdAt,
          source: info.source,
          width: info.width,
          height: info.height,
        })
        cacheImage(id, dataUrl)
        importedImageIds.push(id)
      }

      for (const [id, info] of Object.entries(data.thumbnailFiles ?? {})) {
        const bytes = unzipped[info.path]
        if (!bytes) continue
        const thumbnailDataUrl = bytesToDataUrl(bytes, info.path)
        await putImageThumbnail({
          id,
          thumbnailDataUrl,
          width: info.width,
          height: info.height,
          thumbnailVersion: info.thumbnailVersion,
        })
        cacheThumbnail(id, {
          dataUrl: thumbnailDataUrl,
          width: info.width,
          height: info.height,
          thumbnailVersion: info.thumbnailVersion,
        })
      }

      for (const task of data.tasks) {
        await putTask(task)
      }

      const tasks = await getAllTasks()
      useStore.getState().setTasks(tasks)
      skipSupportPromptForImportedData(tasks)
      scheduleThumbnailBackfill(importedImageIds)
    }

    if (options.importConfig && data.settings) {
      const state = useStore.getState()
      state.setSettings(mergeImportedSettings(state.settings, data.settings))
    }

    let msg = '数据已成功导入'
    if (options.importTasks && data.tasks) {
      msg = `已导入 ${data.tasks.length} 条记录`
    } else if (options.importConfig && data.settings) {
      msg = '配置已成功导入'
    }

    useStore.getState().showToast(msg, 'success')
    return true
  } catch (e) {
    useStore
      .getState()
      .showToast(
        `导入失败：${e instanceof Error ? e.message : String(e)}`,
        'error',
      )
    return false
  }
}

/** 添加图片到输入（文件上传） */
export async function addImageFromFile(file: File): Promise<void> {
  if (!file.type.startsWith('image/')) return
  const dataUrl = await fileToDataUrl(file)
  const id = await storeImage(dataUrl, 'upload')
  cacheImage(id, dataUrl)
  useStore.getState().addInputImage({ id, dataUrl })
}

/** 添加图片到输入（右键菜单）—— 支持 data/blob/http URL */
export async function addImageFromUrl(src: string): Promise<void> {
  const res = await fetch(src)
  const blob = await res.blob()
  if (!blob.type.startsWith('image/')) throw new Error('不是有效的图片')
  const dataUrl = await blobToDataUrl(blob)
  const id = await storeImage(dataUrl, 'upload')
  cacheImage(id, dataUrl)
  useStore.getState().addInputImage({ id, dataUrl })
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}

