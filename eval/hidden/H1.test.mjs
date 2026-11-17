import test from 'node:test'
import assert from 'node:assert/strict'
import { createQueue, AbortError, TimeoutError } from '../src/queue.js'

function fakeTimers() {
  let now = 0, id = 0
  const pending = new Map()
  const flush = () => new Promise((r) => setImmediate(r))
  return {
    timers: {
      setTimeout(fn, ms) { const i = ++id; pending.set(i, { at: now + Math.max(0, ms || 0), fn, i }); return i },
      clearTimeout(i) { pending.delete(i) },
    },
    get now() { return now },
    count: () => pending.size,
    flush,
    async advance(ms) {
      const target = now + ms
      await flush()
      for (;;) {
        let next = null
        for (const t of pending.values()) if (t.at <= target && (!next || t.at < next.at || (t.at === next.at && t.i < next.i))) next = t
        if (!next) break
        pending.delete(next.i)
        now = next.at
        next.fn()
        await flush()
      }
      now = target
      await flush()
    },
  }
}
const sleep = (ft, ms, v) => new Promise((r) => ft.timers.setTimeout(() => r(v), ms))
const never = () => new Promise(() => {})
const settle = (p) => p.then((v) => ({ ok: true, v }), (e) => ({ ok: false, e }))

for (const bad of [0, -1, 1.5, NaN, '2', Infinity]) {
  test('Q01 invalid concurrency throws RangeError: ' + String(bad), () => {
    assert.throws(() => createQueue({ concurrency: bad }), RangeError)
    const q = createQueue()
    assert.throws(() => q.setConcurrency(bad), RangeError)
  })
}
test('Q02 task does not start synchronously inside add', async () => {
  const ft = fakeTimers(); const q = createQueue({ timers: ft.timers })
  let started = false
  const p = q.add(() => { started = true; return 1 })
  assert.equal(started, false)
  await ft.flush()
  assert.equal(started, true)
  assert.equal(await p, 1)
})
test('Q03 priority then FIFO', async () => {
  const ft = fakeTimers(); const q = createQueue({ timers: ft.timers }); q.pause()
  const order = []
  const ps = ['a0', 'b1', 'c1', 'd0', 'e2'].map((n) => q.add(() => order.push(n), { priority: +n[1] }))
  q.resume(); await Promise.all(ps)
  assert.deepEqual(order, ['e2', 'b1', 'c1', 'a0', 'd0'])
})
test('Q04 fn receives attempt and AbortSignal', async () => {
  const ft = fakeTimers(); const q = createQueue({ timers: ft.timers })
  let arg
  await q.add((a) => { arg = a })
  assert.equal(arg.attempt, 1)
  assert.ok(arg.signal instanceof AbortSignal)
  assert.equal(arg.signal.aborted, false)
})
test('Q05 synchronous throw is a retryable failure', async () => {
  const ft = fakeTimers(); const q = createQueue({ timers: ft.timers })
  let n = 0
  const p = q.add(({ attempt }) => { n++; if (attempt === 1) throw new Error('x'); return 'ok' }, { retries: 1, backoffMs: 10 })
  await ft.advance(10)
  assert.equal(await p, 'ok'); assert.equal(n, 2)
})
test('Q06 exponential backoff through injected timers, final error is the last one', async () => {
  const ft = fakeTimers(); const q = createQueue({ timers: ft.timers })
  const times = []
  const p = settle(q.add(({ attempt }) => { times.push(ft.now); throw new Error('e' + attempt) }, { retries: 3, backoffMs: 100 }))
  await ft.advance(1000)
  const r = await p
  assert.deepEqual(times, [0, 100, 300, 700])
  assert.equal(r.ok, false); assert.equal(r.e.message, 'e4')
})
test('Q07 backoff releases the slot and is not counted in size', async () => {
  const ft = fakeTimers(); const q = createQueue({ timers: ft.timers })
  const starts = []
  q.add(({ attempt }) => { starts.push('A' + attempt + '@' + ft.now); if (attempt === 1) throw new Error('x') }, { retries: 1, backoffMs: 1000 })
  q.add(() => { starts.push('B@' + ft.now); return sleep(ft, 50) })
  await ft.advance(10)
  assert.deepEqual(starts, ['A1@0', 'B@0'])
  assert.equal(q.size, 0); assert.equal(q.pending, 1)
  await ft.advance(2000)
  assert.deepEqual(starts, ['A1@0', 'B@0', 'A2@1000'])
})
test('Q08 retried task keeps its original add position', async () => {
  const ft = fakeTimers(); const q = createQueue({ timers: ft.timers })
  const starts = []
  const ps = [
    q.add(({ attempt }) => { starts.push('A' + attempt); if (attempt === 1) return Promise.reject(new Error('x')) }, { retries: 1, backoffMs: 100 }),
    q.add(() => { starts.push('B'); return sleep(ft, 500) }),
    q.add(() => { starts.push('C') }),
  ]
  await ft.advance(1000); await Promise.all(ps)
  assert.deepEqual(starts, ['A1', 'B', 'A2', 'C'])
})
test('Q09 timeout rejects with TimeoutError, aborts attempt signal, frees slot immediately', async () => {
  const ft = fakeTimers(); const q = createQueue({ timers: ft.timers })
  let sig, resolveLate
  const p = settle(q.add(({ signal }) => { sig = signal; return new Promise((r) => { resolveLate = r }) }, { timeoutMs: 50 }))
  let bStart = null
  q.add(() => { bStart = ft.now })
  await ft.advance(49)
  assert.equal(bStart, null)
  await ft.advance(1)
  const r = await p
  assert.equal(r.ok, false); assert.ok(r.e instanceof TimeoutError)
  assert.equal(sig.aborted, true)
  assert.equal(bStart, 50)
  resolveLate('late'); await ft.flush()
})
test('Q10 late result of a timed-out attempt is ignored; retry result wins', async () => {
  const ft = fakeTimers(); const q = createQueue({ timers: ft.timers })
  const p = q.add(({ attempt }) => attempt === 1 ? sleep(ft, 70, 'late') : sleep(ft, 30, 'ok'), { timeoutMs: 50, retries: 1, backoffMs: 10 })
  await ft.advance(400)
  assert.equal(await p, 'ok')
})
test('Q11 abort while waiting: fn never runs', async () => {
  const ft = fakeTimers(); const q = createQueue({ timers: ft.timers })
  q.add(() => sleep(ft, 100))
  const ac = new AbortController()
  let called = false
  const p = settle(q.add(() => { called = true }, { signal: ac.signal }))
  await ft.flush()
  assert.equal(q.size, 1)
  ac.abort()
  const r = await p
  assert.ok(r.e instanceof AbortError)
  assert.equal(q.size, 0)
  await ft.advance(200)
  assert.equal(called, false)
})
test('Q12 abort while running: immediate rejection, slot freed, attempt signal aborted', async () => {
  const ft = fakeTimers(); const q = createQueue({ timers: ft.timers })
  const ac = new AbortController()
  let sig
  const p = settle(q.add(({ signal }) => { sig = signal; return sleep(ft, 1000, 'v') }, { signal: ac.signal }))
  let bStart = null
  q.add(() => { bStart = ft.now })
  await ft.advance(10)
  ac.abort()
  const r = await p
  assert.ok(r.e instanceof AbortError)
  assert.equal(sig.aborted, true)
  await ft.flush()
  assert.equal(bStart, 10)
  await ft.advance(2000)
})
test('Q13 abort during backoff cancels the retry', async () => {
  const ft = fakeTimers(); const q = createQueue({ timers: ft.timers })
  const ac = new AbortController()
  let n = 0
  const p = settle(q.add(() => { n++; throw new Error('x') }, { signal: ac.signal, retries: 5, backoffMs: 100 }))
  await ft.advance(50)
  ac.abort()
  const r = await p
  assert.ok(r.e instanceof AbortError)
  await ft.advance(10000)
  assert.equal(n, 1)
  await q.onIdle()
})
test('Q14 pre-aborted signal rejects without enqueueing', async () => {
  const ft = fakeTimers(); const q = createQueue({ timers: ft.timers })
  const ac = new AbortController(); ac.abort()
  let called = false
  const r = await settle(q.add(() => { called = true }, { signal: ac.signal }))
  assert.ok(r.e instanceof AbortError)
  assert.equal(q.size, 0)
  await ft.flush(); assert.equal(called, false)
})
test('Q15 external abort is never retried', async () => {
  const ft = fakeTimers(); const q = createQueue({ timers: ft.timers })
  const ac = new AbortController()
  let n = 0
  const p = settle(q.add(({ signal }) => { n++; return new Promise((_, rej) => signal.addEventListener('abort', () => rej(new Error('aborted inside')))) }, { signal: ac.signal, retries: 5, backoffMs: 1 }))
  await ft.flush(); ac.abort()
  const r = await p
  assert.ok(r.e instanceof AbortError)
  await ft.advance(1000)
  assert.equal(n, 1)
})
test('Q16 pause stops new starts; finished backoff returns to waiting but waits for resume', async () => {
  const ft = fakeTimers(); const q = createQueue({ timers: ft.timers, concurrency: 2 })
  const starts = []
  q.add(({ attempt }) => { starts.push('A' + attempt); if (attempt === 1) throw new Error('x') }, { retries: 1, backoffMs: 100 })
  q.add(() => { starts.push('B'); return sleep(ft, 300) })
  await ft.flush()
  q.pause()
  q.add(() => { starts.push('C') })
  await ft.advance(200)
  assert.deepEqual(starts, ['A1', 'B'])
  assert.equal(q.size, 2)
  assert.equal(q.pending, 1)
  q.resume(); await ft.flush()
  assert.deepEqual(starts, ['A1', 'B', 'A2', 'C'])
  await ft.advance(500)
})
test('Q17 setConcurrency up starts more, down does not interrupt', async () => {
  const ft = fakeTimers(); const q = createQueue({ timers: ft.timers, concurrency: 1 })
  for (let i = 0; i < 4; i++) q.add(() => sleep(ft, 100))
  await ft.flush(); assert.equal(q.pending, 1)
  q.setConcurrency(3); await ft.flush()
  assert.equal(q.pending, 3); assert.equal(q.size, 1)
  q.setConcurrency(1); await ft.flush()
  assert.equal(q.pending, 3)
  await ft.advance(100)
  assert.equal(q.pending, 1); assert.equal(q.size, 0)
  await ft.advance(100)
  await q.onIdle()
})
test('Q18 clear rejects only waiting tasks', async () => {
  const ft = fakeTimers(); const q = createQueue({ timers: ft.timers })
  const a = settle(q.add(() => sleep(ft, 100, 'a')))
  const b = settle(q.add(({ attempt }) => { if (attempt === 1) throw new Error('x'); return 'b' }, { retries: 1, backoffMs: 1000, priority: 9 }))
  const c = settle(q.add(() => 'c'))
  await ft.flush()
  q.clear()
  assert.ok((await c).e instanceof AbortError)
  await ft.advance(2000)
  assert.deepEqual(await a, { ok: true, v: 'a' })
  assert.deepEqual(await b, { ok: true, v: 'b' })
})
test('Q19 onIdle waits for running, waiting and backoff; resolves at once when idle', async () => {
  const ft = fakeTimers(); const q = createQueue({ timers: ft.timers })
  let idle = false
  await q.onIdle()
  q.add(({ attempt }) => { if (attempt === 1) throw new Error('x') }, { retries: 1, backoffMs: 500 })
  q.onIdle().then(() => { idle = true })
  await ft.advance(100)
  assert.equal(idle, false)
  await ft.advance(500)
  assert.equal(idle, true)
})
test('Q20 error classes', () => {
  assert.ok(new AbortError() instanceof Error); assert.equal(new AbortError().name, 'AbortError')
  assert.ok(new TimeoutError() instanceof Error); assert.equal(new TimeoutError().name, 'TimeoutError')
})
test('Q21 next task starts via microtasks, not timers', async () => {
  const ft = fakeTimers(); const q = createQueue({ timers: ft.timers })
  const order = []
  q.add(() => { order.push('a') }); q.add(() => { order.push('b') }); q.add(() => { order.push('c') })
  await ft.flush(); await ft.flush()
  assert.deepEqual(order, ['a', 'b', 'c'])
  assert.equal(ft.count(), 0)
})
test('Q22 add returns the resolved value and rejects with the original error when no retries', async () => {
  const ft = fakeTimers(); const q = createQueue({ timers: ft.timers })
  const err = new Error('boom')
  assert.equal(await q.add(async () => 42), 42)
  const r = await settle(q.add(async () => { throw err }))
  assert.equal(r.e, err)
})
