export class AbortError extends Error { constructor(m = 'aborted') { super(m); this.name = 'AbortError' } }
export class TimeoutError extends Error { constructor(m = 'timed out') { super(m); this.name = 'TimeoutError' } }

const posInt = (n) => Number.isInteger(n) && n > 0
const defaultTimers = { setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: (id) => clearTimeout(id) }

export function createQueue({ concurrency = 1, timers = defaultTimers } = {}) {
  if (!posInt(concurrency)) throw new RangeError('concurrency')
  const waiting = []
  const running = new Set()
  const backoff = new Set()
  const idle = []
  let paused = false, seq = 0, scheduled = false

  const schedule = () => {
    if (scheduled) return
    scheduled = true
    queueMicrotask(() => { scheduled = false; drain() })
  }
  const checkIdle = () => queueMicrotask(() => {
    if (!running.size && !waiting.length && !backoff.size) idle.splice(0).forEach((r) => r())
  })
  const after = () => { schedule(); checkIdle() }
  const pick = () => {
    let best = 0
    for (let i = 1; i < waiting.length; i++) {
      const a = waiting[i], b = waiting[best]
      if (a.priority > b.priority || (a.priority === b.priority && a.seq < b.seq)) best = i
    }
    return waiting.splice(best, 1)[0]
  }
  function drain() {
    while (!paused && running.size < concurrency && waiting.length) start(pick())
  }
  function endAttempt(job) {
    if (job.timer !== undefined) { timers.clearTimeout(job.timer); job.timer = undefined }
    running.delete(job)
    job.current = null
  }
  function finish(job, ok, value) {
    job.state = 'done'
    if (job.signal) job.signal.removeEventListener('abort', job.onAbort)
    ok ? job.resolve(value) : job.reject(value)
    after()
  }
  function start(job) {
    job.state = 'running'
    running.add(job)
    const token = {}
    job.current = token
    const ctrl = new AbortController()
    job.ctrl = ctrl
    const attempt = ++job.attempts
    if (job.timeoutMs !== undefined) {
      job.timer = timers.setTimeout(() => {
        if (job.current !== token) return
        job.timer = undefined
        fail(job, token, new TimeoutError())
        ctrl.abort()
      }, job.timeoutMs)
    }
    let r
    try { r = job.fn({ signal: ctrl.signal, attempt }) } catch (e) { fail(job, token, e); return }
    Promise.resolve(r).then((v) => { if (job.current === token) { endAttempt(job); finish(job, true, v) } }, (e) => fail(job, token, e))
  }
  function fail(job, token, err) {
    if (job.current !== token) return
    endAttempt(job)
    job.failures++
    if (job.failures <= job.retries) {
      job.state = 'backoff'
      backoff.add(job)
      job.backoffTimer = timers.setTimeout(() => {
        backoff.delete(job)
        job.backoffTimer = undefined
        job.state = 'waiting'
        waiting.push(job)
        after()
      }, job.backoffMs * 2 ** (job.failures - 1))
      after()
      return
    }
    finish(job, false, err)
  }
  function abort(job) {
    if (job.state === 'done') return
    if (job.state === 'waiting') waiting.splice(waiting.indexOf(job), 1)
    else if (job.state === 'running') { const c = job.ctrl; endAttempt(job); c.abort() }
    else if (job.state === 'backoff') { timers.clearTimeout(job.backoffTimer); backoff.delete(job) }
    finish(job, false, new AbortError())
  }

  return {
    add(fn, { priority = 0, signal, retries = 0, backoffMs = 100, timeoutMs } = {}) {
      if (signal && signal.aborted) return Promise.reject(new AbortError())
      return new Promise((resolve, reject) => {
        const job = { fn, priority, signal, retries, backoffMs, timeoutMs, seq: seq++, resolve, reject, attempts: 0, failures: 0, state: 'waiting' }
        if (signal) { job.onAbort = () => abort(job); signal.addEventListener('abort', job.onAbort) }
        waiting.push(job)
        schedule()
      })
    },
    pause() { paused = true },
    resume() { paused = false; schedule() },
    setConcurrency(n) { if (!posInt(n)) throw new RangeError('concurrency'); concurrency = n; schedule() },
    clear() { for (const job of waiting.slice()) abort(job) },
    get size() { return waiting.length },
    get pending() { return running.size },
    onIdle() { return new Promise((r) => { idle.push(r); checkIdle() }) },
  }
}
