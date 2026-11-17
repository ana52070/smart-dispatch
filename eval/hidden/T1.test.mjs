import test from 'node:test'
import assert from 'node:assert/strict'
import { createLimiter } from '../src/limiter.js'
const mk = (o = {}) => { const c = { t: 0 }; const l = createLimiter({ capacity: 5, refillPerSec: 2, now: () => c.t, ...o }); return { l, c } }
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, a + ' != ' + b)

test('H1 new key starts full', () => { const { l } = mk(); close(l.available('x'), 5) })
test('H2 keys are isolated', () => { const { l } = mk(); for (let i = 0; i < 5; i++) l.tryTake('a'); assert.equal(l.tryTake('a'), false); assert.equal(l.tryTake('b'), true) })
test('H3 separate limiters do not share state', () => { const a = mk().l; const b = mk().l; for (let i = 0; i < 5; i++) a.tryTake('k'); assert.equal(b.tryTake('k'), true) })
test('H4 fractional refill is kept', () => { const { l, c } = mk(); l.tryTake('a', 5); c.t = 250; close(l.available('a'), 0.5); c.t = 500; close(l.available('a'), 1) })
test('H5 refill capped at capacity', () => { const { l, c } = mk(); l.tryTake('a', 1); c.t = 1e7; close(l.available('a'), 5); assert.equal(l.tryTake('a', 5), true); assert.equal(l.tryTake('a', 0.1), false) })
test('H6 insufficient tokens do not deduct', () => { const { l } = mk(); l.tryTake('a', 4); assert.equal(l.tryTake('a', 2), false); close(l.available('a'), 1) })
test('H7 cost greater than capacity is rejected without consuming', () => { const { l } = mk(); assert.equal(l.tryTake('a', 6), false); close(l.available('a'), 5) })
test('H8 cost equal to capacity is allowed', () => { const { l } = mk(); assert.equal(l.tryTake('a', 5), true); close(l.available('a'), 0) })
test('H9 fractional cost', () => { const { l } = mk(); assert.equal(l.tryTake('a', 2.5), true); close(l.available('a'), 2.5) })
for (const bad of [0, -1, NaN, Infinity, '1']) {
  test('H10 invalid cost throws RangeError: ' + String(bad), () => { const { l } = mk(); assert.throws(() => l.tryTake('a', bad), RangeError) })
}
for (const [k, v] of [['capacity', 0], ['capacity', -3], ['refillPerSec', 0], ['refillPerSec', Infinity], ['capacity', NaN]]) {
  test('H11 invalid config throws RangeError: ' + k + '=' + v, () => { assert.throws(() => createLimiter({ capacity: 5, refillPerSec: 1, [k]: v }), RangeError) })
}
test('H12 clock going backwards neither refills nor drains, and rebases', () => {
  const { l, c } = mk(); c.t = 1000; l.tryTake('a', 5); c.t = 400; close(l.available('a'), 0); c.t = 900; close(l.available('a'), 1)
})
test('H13 available on unseen key returns capacity without side effects', () => {
  const { l, c } = mk(); c.t = 100; close(l.available('z'), 5); c.t = 200; assert.equal(l.tryTake('z', 5), true); close(l.available('z'), 0)
})
test('H14 default cost is 1', () => { const { l } = mk(); l.tryTake('a'); close(l.available('a'), 4) })
test('H15 bucket created at first use, refill measured from then', () => { const { l, c } = mk(); c.t = 5000; l.tryTake('a', 5); c.t = 5500; close(l.available('a'), 1) })
