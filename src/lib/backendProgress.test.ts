import { describe, expect, it } from 'vitest'
import { getBackendProcessedCount } from './backendProgress'

describe('getBackendProcessedCount', () => {
  it('counts completed, failed, and skipped requests as processed', () => {
    expect(getBackendProcessedCount({
      total: 5,
      completed: 2,
      failed: 1,
      skipped: 1,
    })).toBe(4)
  })

  it('caps processed requests at total', () => {
    expect(getBackendProcessedCount({
      total: 3,
      completed: 2,
      failed: 1,
      skipped: 2,
    })).toBe(3)
  })

  it('returns zero without progress', () => {
    expect(getBackendProcessedCount(null)).toBe(0)
  })
})
