// A minimal concurrency-limited queue. Needs to be extended per README.md.
export class AbortError extends Error {}
export class TimeoutError extends Error {}

export function createQueue({ concurrency = 1 } = {}) {
  const waiting = []
  let running = 0

  function next() {
    while (running < concurrency && waiting.length) {
      const job = waiting.shift()
      running++
      Promise.resolve()
        .then(() => job.fn())
        .then(job.resolve, job.reject)
        .finally(() => { running--; next() })
    }
  }

  return {
    add(fn) {
      return new Promise((resolve, reject) => {
        waiting.push({ fn, resolve, reject })
        next()
      })
    },
    get size() { return waiting.length },
    get pending() { return running },
  }
}
