import { describe, expect, it } from 'vitest'
import { ApiError } from '@/api/client'
import { shouldRetry } from '@/lib/query-client'
import { isDreamActive } from './dreams'
import { LEARNING_FAILED_POLL_MS, LEARNING_POLL_MS, learningPollInterval } from './experiences'

describe('polling policies', () => {
  it('polls experiences until processed (slower after failures)', () => {
    expect(learningPollInterval(undefined)).toBe(false)
    expect(learningPollInterval({ processing_status: 'pending' })).toBe(LEARNING_POLL_MS)
    expect(learningPollInterval({ processing_status: 'failed' })).toBe(LEARNING_FAILED_POLL_MS)
    expect(learningPollInterval({ processing_status: 'processed' })).toBe(false)
  })

  it('treats queued/running dreams as active', () => {
    expect(isDreamActive({ status: 'queued' })).toBe(true)
    expect(isDreamActive({ status: 'running' })).toBe(true)
    expect(isDreamActive({ status: 'succeeded' })).toBe(false)
    expect(isDreamActive({ status: 'failed' })).toBe(false)
    expect(isDreamActive(undefined)).toBe(false)
  })
})

describe('query retry policy', () => {
  const err = (status: number) =>
    new ApiError(status, { code: 'x', message: 'x', details: {}, request_id: null })
  it('never retries deterministic 4xx errors', () => {
    expect(shouldRetry(0, err(401))).toBe(false)
    expect(shouldRetry(0, err(404))).toBe(false)
    expect(shouldRetry(0, err(409))).toBe(false)
  })
  it('retries transient failures at most twice', () => {
    expect(shouldRetry(0, err(503))).toBe(true)
    expect(shouldRetry(1, err(0))).toBe(true)
    expect(shouldRetry(2, err(500))).toBe(false)
    expect(shouldRetry(0, new TypeError('boom'))).toBe(true)
  })
})
