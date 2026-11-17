// Token-bucket rate limiter.
const state = { tokens: 0, last: 0, started: false }

export function createLimiter({ capacity, refillPerSec, now = Date.now }, buckets = state) {
  function refill() {
    const t = now()
    if (!buckets.started) {
      buckets.tokens = capacity
      buckets.last = t
      buckets.started = true
      return
    }
    const elapsed = t - buckets.last
    buckets.tokens += Math.floor((elapsed / 1000) * refillPerSec)
    buckets.last = t
  }

  return {
    tryTake(key, cost = 1) {
      refill()
      if (buckets.tokens >= cost) {
        buckets.tokens -= cost
        return true
      }
      return false
    },
    available(key) {
      refill()
      return buckets.tokens
    },
  }
}
