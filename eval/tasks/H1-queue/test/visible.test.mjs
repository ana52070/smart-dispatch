import test from 'node:test'
import assert from 'node:assert/strict'
import { createQueue } from '../src/queue.js'

test('respects concurrency', async () => {
  const q = createQueue({ concurrency: 2 })
  let active = 0, max = 0
  const job = () => new Promise((r) => { active++; max = Math.max(max, active); setTimeout(() => { active--; r() }, 5) })
  await Promise.all([q.add(job), q.add(job), q.add(job), q.add(job)])
  assert.equal(max, 2)
})

test('priority order', async () => {
  const q = createQueue({ concurrency: 1 })
  q.pause()
  const order = []
  const ps = [q.add(() => order.push('low')), q.add(() => order.push('high'), { priority: 5 })]
  q.resume()
  await Promise.all(ps)
  assert.deepEqual(order, ['high', 'low'])
})
