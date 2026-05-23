import { describe, expect, it } from 'vitest'
import { JsonStore } from './store.js'

describe('JsonStore normalization', () => {
  it('preserves the default b64 response format for legacy active profiles', () => {
    const store = new JsonStore('tmp/db.json')

    const normalized = store.normalize({
      settings: {
        activeProfile: {
          model: 'legacy-model',
        },
      },
    })

    expect(normalized.settings.activeProfile.responseFormatB64Json).toBe(true)
  })

  it('preserves an explicit disabled b64 response format', () => {
    const store = new JsonStore('tmp/db.json')

    const normalized = store.normalize({
      settings: {
        activeProfile: {
          responseFormatB64Json: false,
        },
      },
    })

    expect(normalized.settings.activeProfile.responseFormatB64Json).toBe(false)
  })
})
