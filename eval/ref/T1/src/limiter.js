function positive(v) { return typeof v === 'number' && Number.isFinite(v) && v > 0 }
export function createLimiter({ capacity, refillPerSec, now = Date.now } = {}) {
  if (!positive(capacity) || !positive(refillPerSec)) throw new RangeError('bad config')
  const buckets = new Map()
  function settle(key) {
    const t = now()
    let b = buckets.get(key)
    if (!b) { b = { tokens: capacity, last: t }; buckets.set(key, b); return b }
    if (t >= b.last) b.tokens = Math.min(capacity, b.tokens + (t - b.last) * refillPerSec / 1000)
    b.last = t
    return b
  }
  return {
    tryTake(key, cost = 1) {
      if (!positive(cost)) throw new RangeError('bad cost')
      const b = settle(key)
      if (cost > capacity || b.tokens < cost) return false
      b.tokens -= cost
      return true
    },
    available(key) {
      if (!buckets.has(key)) return capacity
      return settle(key).tokens
    },
  }
}
