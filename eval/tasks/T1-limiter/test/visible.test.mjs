import test from 'node:test'
import assert from 'node:assert/strict'
import { createLimiter } from '../src/limiter.js'

test('slow refill accumulates fractional tokens', () => {
  let t = 0
  const l = createLimiter({ capacity: 2, refillPerSec: 1, now: () => t })
  assert.equal(l.tryTake('a'), true)
  assert.equal(l.tryTake('a'), true)
  assert.equal(l.tryTake('a'), false)
  t += 500; assert.equal(l.tryTake('a'), false)
  t += 500; assert.equal(l.tryTake('a'), true)
})
