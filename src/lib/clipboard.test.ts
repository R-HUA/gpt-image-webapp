import { afterEach, describe, expect, it, vi } from 'vitest'
import { copyBlobToClipboard } from './clipboard'

describe('copyBlobToClipboard', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('falls back to copying a Data URL when image clipboard APIs are unavailable', async () => {
    const writeText = vi.fn(async (_text: string) => undefined)
    vi.stubGlobal('navigator', {
      clipboard: { writeText },
    })
    vi.stubGlobal('ClipboardItem', undefined)

    const result = await copyBlobToClipboard(new Blob(['hello'], { type: 'image/png' }))

    expect(result).toBe('data-url')
    expect(writeText).toHaveBeenCalledTimes(1)
    expect(writeText).toHaveBeenCalledWith('data:image/png;base64,aGVsbG8=')
  })
})
