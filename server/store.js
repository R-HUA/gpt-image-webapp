import { promises as fs } from 'node:fs'
import path from 'node:path'

const EMPTY_DB = {
  users: [],
  apiKeys: [],
  settings: {
    concurrency: 2,
    serverImagePath: '',
    activeProfile: {
      provider: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: '',
      model: 'gpt-image-2',
      apiMode: 'images',
      timeout: 300,
      responseFormatB64Json: true,
      codexCli: false,
    },
  },
  results: [],
  batchUploads: [],
  auditLogs: [],
}

export class JsonStore {
  constructor(filePath) {
    this.filePath = filePath
    this.data = structuredClone(EMPTY_DB)
    this.writeLock = Promise.resolve()
  }

  async init() {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true })
    try {
      const raw = await fs.readFile(this.filePath, 'utf8')
      this.data = this.normalize(JSON.parse(raw))
    } catch (err) {
      if (err?.code !== 'ENOENT') throw err
      await this.save()
    }
  }

  normalize(data) {
    return {
      ...structuredClone(EMPTY_DB),
      ...(data && typeof data === 'object' ? data : {}),
      settings: {
        ...EMPTY_DB.settings,
        ...(data?.settings && typeof data.settings === 'object' ? data.settings : {}),
        activeProfile: {
          ...EMPTY_DB.settings.activeProfile,
          ...(data?.settings?.activeProfile && typeof data.settings.activeProfile === 'object' ? data.settings.activeProfile : {}),
        },
      },
      users: Array.isArray(data?.users) ? data.users : [],
      apiKeys: Array.isArray(data?.apiKeys) ? data.apiKeys : [],
      results: Array.isArray(data?.results) ? data.results : [],
      batchUploads: Array.isArray(data?.batchUploads) ? data.batchUploads : [],
      auditLogs: Array.isArray(data?.auditLogs) ? data.auditLogs : [],
    }
  }

  async save() {
    // Defer serialization into the lock chain so each write always captures
    // the latest in-memory state, avoiding stale-snapshot races when multiple
    // concurrent jobs call save() between awaits.
    this.writeLock = this.writeLock.then(() =>
      fs.writeFile(this.filePath, JSON.stringify(this.data, null, 2))
    )
    await this.writeLock
  }
}
